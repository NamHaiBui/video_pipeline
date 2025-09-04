import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger.js';
import { Upload } from '@aws-sdk/lib-storage';
import { withSemaphore, s3Semaphore, metrics, withRetry, computeDefaultConcurrency, getConcurrencyFromEnv } from './utils/concurrency.js';

export interface S3Config {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  audioBucket: string;
  videoBucket: string;
  metadataBucket?: string;
}

export interface S3UploadResult {
  success: boolean;
  key: string;
  bucket: string;
  location:string;
  uri: string;
  error?: string;
}

/**
 * Retry utility for S3 operations with exponential backoff
 */
class S3RetryUtility {
  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_DELAY = 1000; // 1 second

  // AWS error codes that should not be retried
  private static readonly NON_RETRYABLE_ERROR_CODES = [
    'AccessDenied',
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'TokenRefreshRequired',
    'InvalidBucketName',
    'NoSuchBucket',
    'BucketNotEmpty',
    'InvalidArgument'
  ];

  // Error names that should be retried (network/timeout related)
  private static readonly RETRYABLE_ERROR_NAMES = [
    'NetworkError',
    'TimeoutError',
    'AbortError',
    'RequestTimeout',
    'ServiceUnavailable',
    'InternalError',
    'SlowDown',
    'Throttling'
  ];

  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    retryCount: number = 0
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      // Check if this is a non-retryable error
      const errorCode = error?.code || error?.name || '';
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      
      // Don't retry authentication or validation errors
      if (this.NON_RETRYABLE_ERROR_CODES.includes(errorCode)) {
        logger.error(`❌ ${operationName} failed with non-retryable error: ${errorCode} - ${errorMessage}`);
        throw error;
      }

      if (retryCount >= this.MAX_RETRIES - 1) {
        const errorDetails = {
          message: errorMessage,
          code: errorCode,
          stack: error?.stack,
          originalError: error
        };
        logger.error(`❌ ${operationName} failed after ${this.MAX_RETRIES} attempts:`, errorMessage, errorDetails);
        throw error;
      }

      const delay = this.BASE_DELAY * Math.pow(2, retryCount);
      
      // Special handling for AbortError
      if (errorCode === 'AbortError' || errorMessage.includes('aborted')) {
        logger.warn(`⚠️ ${operationName} was aborted (attempt ${retryCount + 1}/${this.MAX_RETRIES}), retrying in ${delay}ms...`);
      } else {
        logger.warn(`⚠️ ${operationName} failed (attempt ${retryCount + 1}/${this.MAX_RETRIES}) with error: ${errorCode} - ${errorMessage}, retrying in ${delay}ms...`);
      }
      
      await this.sleep(delay);
      return this.executeWithRetry(operation, operationName, retryCount + 1);
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class S3Service {
  private s3Client: S3Client;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    
    // Initialize S3 client with credentials from environment or config
    const clientConfig: any = {
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      } : undefined, // Uses default credential chain if not provided
    };

    this.s3Client = new S3Client(clientConfig);
  }

  /**
   * Upload a file to S3
   */
  async uploadFile(
    filePath: string, 
    bucket: string, 
    key: string, 
    contentType?: string
  ): Promise<S3UploadResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          key,
          bucket,
          location: '',
          uri: '',
          error: `File does not exist: ${filePath}`
        };
      }

      const stats = fs.statSync(filePath);
      
      // Determine content type if not provided
      if (!contentType) {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
          case '.mp4':
            contentType = 'video/mp4';
            break;
          case '.mp3':
            contentType = 'audio/mpeg';
            break;
          case '.opus':
            contentType = 'audio/opus';
            break;
          case '.json':
            contentType = 'application/json';
            break;
          case '.txt':
            contentType = 'text/plain';
            break;
          case '.jpeg':
            contentType = 'image/jpeg';
            break;
          case '.m3u8':
            contentType = 'application/vnd.apple.mpegurl';
            break;
          default:
            contentType = 'application/octet-stream';
        }
      }

  // Tune multipart upload for throughput
  const partSizeBytes = Math.max(5, parseInt(process.env.S3_UPLOAD_PART_SIZE_MB || '16', 10)) * 1024 * 1024;
  const queueSize = Math.max(1, parseInt(process.env.S3_UPLOAD_QUEUE_SIZE || '8', 10));

  // Use Upload for multipart upload with retry - recreate stream on each attempt
      const result = await withSemaphore(s3Semaphore, 's3_upload', async () => {
        return withRetry(async () => {
          // Create a fresh file stream for each retry attempt
          const fileStream = fs.createReadStream(filePath);
          const upload = new Upload({
            client: this.s3Client,
            params: {
              Bucket: bucket,
              Key: key,
              Body: fileStream,
              ContentType: contentType,
              ContentLength: stats.size,
              Metadata: {
                'upload-timestamp': new Date().toISOString(),
                'original-filename': path.basename(filePath),
                'file-size': stats.size.toString()
              }
    },
    queueSize,
    partSize: partSizeBytes,
    leavePartsOnError: false
          });
          return await upload.done();
        }, {
          attempts: parseInt(process.env.RETRY_ATTEMPTS || '3', 10),
          baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '500', 10),
          label: 's3_upload',
          isRetryable: (err) => {
            const code = err?.code || err?.name || '';
            const NON_RETRYABLE = new Set([
              'AccessDenied',
              'InvalidAccessKeyId',
              'SignatureDoesNotMatch',
              'TokenRefreshRequired',
              'InvalidBucketName',
              'NoSuchBucket',
              'BucketNotEmpty',
              'InvalidArgument'
            ]);
            return !NON_RETRYABLE.has(code);
          },
          onAttempt: ({ attempt, attempts, delay }) => {
            logger.warn(`⚠️ S3 upload retry ${attempt}/${attempts} in ${delay}ms for ${key}`);
          }
        });
      });
      // result.
      const uri = `s3://${bucket}/${key}`;
      const location = result.Location ||`https://${bucket}.s3.us-east-1.amazonaws.com/${key}`;
      logger.info(`✅ Successfully uploaded ${filePath} to ${uri}`);
      logger.info(`📁 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      return {
        success: true,
        key,
        bucket,
        location,
        uri,
      };

    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      const errorCode = error?.code || error?.name || 'UNKNOWN_ERROR';
      const errorDetails = {
        message: errorMessage,
        code: errorCode,
        stack: error?.stack,
        originalError: error
      };
      
      logger.error(`❌ Failed to upload ${filePath} to S3:`, errorMessage, errorDetails);
      return {
          success: false,
          key,
          bucket,
          location: '',
          uri: '',
          error: errorMessage
      };
    }
  }

  /**
   * High-throughput concurrent ranged download from S3 to a local file
   */
  async downloadFile(
    bucket: string,
    key: string,
    destinationPath: string,
    opts?: { partSizeMB?: number; concurrency?: number }
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const head = await withSemaphore(s3Semaphore, 's3_head', async () =>
        this.s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      );
      const totalSize = head.ContentLength ?? 0;
      if (!totalSize || totalSize <= 0) {
        // Fallback: single GET when size unknown
        const single = await withSemaphore(s3Semaphore, 's3_get', async () =>
          this.s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        );
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
        const out = fs.createWriteStream(destinationPath);
        await new Promise<void>((resolve, reject) => {
          (single.Body as any).pipe(out)
            .on('finish', resolve)
            .on('error', reject);
        });
        return { success: true, path: destinationPath };
      }

      const partSize = Math.max(5, (opts?.partSizeMB ?? parseInt(process.env.S3_DOWNLOAD_PART_SIZE_MB || '16', 10))) * 1024 * 1024;
      const parts = Math.ceil(totalSize / partSize);
      const dlConcurrency = opts?.concurrency ?? getConcurrencyFromEnv('S3_DOWNLOAD_CONCURRENCY', computeDefaultConcurrency('io'));

      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      const fh = await fs.promises.open(destinationPath, 'w');
      try {
        // Pre-allocate (best effort)
        try { await fh.truncate(totalSize); } catch {}

        let completed = 0;
        const downloadPart = async (index: number) => {
          const start = index * partSize;
          const end = Math.min(totalSize - 1, start + partSize - 1);
          const range = `bytes=${start}-${end}`;

          const res = await withSemaphore(s3Semaphore, 's3_get_part', async () =>
            this.s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }))
          );

          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            (res.Body as any)
              .on('data', (d: Buffer) => chunks.push(d))
              .on('end', resolve)
              .on('error', reject);
          });
          const buf = Buffer.concat(chunks);
          await fh.write(buf, 0, buf.length, start);
          completed++;
          metrics.gauge('s3_download_parts_completed', completed);
        };

        // Manual concurrency pool
        const pool = Math.max(1, dlConcurrency);
        let next = 0;
        const runners = new Array(pool).fill(0).map(async () => {
          while (next < parts) {
            const i = next++;
            await downloadPart(i);
          }
        });
        await Promise.all(runners);
      } finally {
        await fh.close();
      }

      return { success: true, path: destinationPath };
    } catch (error: any) {
      logger.error(`❌ Failed to download s3://${bucket}/${key}: ${error?.message || error}`);
      try { await fs.promises.unlink(destinationPath); } catch {}
      return { success: false, error: error?.message || String(error) };
    }
  }
  
/**
 * Uploads in-memory data (Buffer) to an S3 bucket.
 * @param data The Buffer content to upload.
 * @param bucket The target S3 bucket name.
 * @param key The desired name/path of the file in the S3 bucket.
 * @returns A promise that resolves to true if successful, false otherwise.
 */
async uploadm3u8ToS3(data: Buffer, bucket: string, key: string): Promise<S3UploadResult> {
    console.log(`Uploading content to S3 bucket '${bucket}' as '${key}'...`);
    try {
    await withSemaphore(s3Semaphore, 's3_put', async () => withRetry(async () => {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'application/vnd.apple.mpegurl' 
      });
      return await this.s3Client.send(command);
    }, { label: 's3_put' }));

        console.log("Upload Successful!");
        return {
            success: true,
            key,
            bucket,
            location: `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`,
            uri: `s3://${bucket}/${key}`
        };
    } catch (error) {
        const errorMessage = (error as any)?.message || (error as any)?.toString() || 'Unknown S3 upload error';
        const errorCode = (error as any)?.code || (error as any)?.name || 'UNKNOWN_ERROR';
        const errorStack = (error as any)?.stack || 'No stack trace available';
        
        const errorDetails = {
            message: errorMessage,
            code: errorCode,
            stack: errorStack,
            originalError: error
        };
        
        logger.error(`❌ Failed to upload buffer to S3:`, errorMessage, errorDetails);
        
        return {
            success: false,
            key,
            bucket,
            location: '',
            uri: '',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
async uploadThumbnailToS3(data: Buffer, bucket: string, key: string): Promise<S3UploadResult> {
    console.log(`Uploading thumbnail to S3 bucket '${bucket}' as '${key}'...`);
    try {
    await withSemaphore(s3Semaphore, 's3_put', async () => withRetry(async () => {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'image/jpeg'
      });
      return await this.s3Client.send(command);
    }, { label: 's3_put' }));

        console.log("Upload Successful!");      
        return {
            success: true,
            key,
            bucket,
            location: `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`,
            uri: `s3://${bucket}/${key}`
        };
    } catch (error) {
        const errorMessage = (error as any)?.message || (error as any)?.toString() || 'Unknown S3 upload error';
        const errorCode = (error as any)?.code || (error as any)?.name || 'UNKNOWN_ERROR';
        const errorStack = (error as any)?.stack || 'No stack trace available';
        
        const errorDetails = {
            message: errorMessage,
            code: errorCode,
            stack: errorStack,
            originalError: error
        };
        
        logger.error(`❌ Failed to upload stream to S3:`, errorMessage, errorDetails);
        
        return {
            success: false,
            key,      
            bucket,
            location: '',
            uri: '',
            error: error instanceof Error ? error.message : String(error)
        };
    }
  }
  /**
   * Upload audio file to the audio bucket
   */
  async uploadAudioFile(filePath: string, keyPrefix?: string): Promise<S3UploadResult> {
    const filename = path.basename(filePath);
    const key = keyPrefix ? `${keyPrefix}/${filename}` : filename;
    
    logger.info(`🔊 Uploading audio file to S3: ${filename}`);
    return this.uploadFile(filePath, this.config.audioBucket, key);
  }

  /**
   * Upload video file to the video bucket
   */
  async uploadVideoFile(filePath: string, keyPrefix?: string): Promise<S3UploadResult> {
    const filename = path.basename(filePath);
    const key = keyPrefix ? `${keyPrefix}/${filename}` : filename;
    
    logger.info(`📹 Uploading video file to S3: ${filename}`);
    return this.uploadFile(filePath, this.config.videoBucket, key);
  }


  /**
   * Generate a presigned URL for downloading a file
   */
  async getPresignedDownloadUrl(bucket: string, key: string, expiresIn = 3600): Promise<string> {
    try {
      const url = await withSemaphore(s3Semaphore, 's3_get', async () => withRetry(async () => {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        return await getSignedUrl(this.s3Client, command, { expiresIn });
      }, { label: 's3_get' }));

      return url;
    } catch (error: any) {
      logger.error(`Failed to generate presigned URL for s3://${bucket}/${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Check if a file exists in S3
   */
  async fileExists(bucket: string, key: string): Promise<boolean> {
    try {
      await withSemaphore(s3Semaphore, 's3_head', async () => withRetry(async () => {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key
        });
        return await this.s3Client.send(command);
      }, { label: 's3_head' }));

      return true;
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(bucket: string, key: string): Promise<boolean> {
    try {
      await withSemaphore(s3Semaphore, 's3_delete', async () => withRetry(async () => {
        const command = new DeleteObjectCommand({
          Bucket: bucket,
          Key: key
        });
        return await this.s3Client.send(command);
      }, { label: 's3_delete' }));

      logger.info(`🗑️ Deleted s3://${bucket}/${key}`);
      return true;
    } catch (error: any) {
      logger.error(`❌ Failed to delete s3://${bucket}/${key}:`, error.message);
      return false;
    }
  }

  /**
   * List all buckets
   */
  async listBuckets(): Promise<string[]> {
    try {
      const result = await S3RetryUtility.executeWithRetry(async () => {
        const { ListBucketsCommand } = await import('@aws-sdk/client-s3');
        const command = new ListBucketsCommand({});
        return await this.s3Client.send(command);
      }, 'List S3 buckets');
      
      return result.Buckets?.map(bucket => bucket.Name || '') || [];
    } catch (error: any) {
      logger.error(`❌ Failed to list buckets:`, error.message);
      return [];
    }
  }

  /**
   * Delete local file after successful S3 upload and clean up empty directories
   */
  async deleteLocalFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        const fileDir = path.dirname(filePath);
        fs.unlinkSync(filePath);
        logger.info(`🗑️ Deleted local file: ${filePath}`);
        
        // Try to clean up empty parent directories
        await this.cleanupEmptyDirectories(fileDir);
        
        return true;
      }
      return false;
    } catch (error: any) {
      logger.error(`Failed to delete local file ${filePath}:`, error.message);
      return false;
    }
  }

  /**
   * Recursively clean up empty directories (private helper method)
   */
  private async cleanupEmptyDirectories(dirPath: string, stopAtRoot: string = process.cwd()): Promise<void> {
    try {
      if (!fs.existsSync(dirPath) || dirPath === stopAtRoot || dirPath === path.dirname(dirPath)) {
        return;
      }
      
      const files = fs.readdirSync(dirPath);
      
      if (files.length === 0) {
        fs.rmdirSync(dirPath);
        logger.info(`🗑️ Removed empty directory: ${path.basename(dirPath)}`);
        
        // Recursively clean up parent directory if it's now empty
        const parentDir = path.dirname(dirPath);
        if (parentDir !== stopAtRoot && parentDir !== dirPath) {
          await this.cleanupEmptyDirectories(parentDir, stopAtRoot);
        }
      }
    } catch (error: any) {
      // Silently ignore directory cleanup errors to avoid disrupting main flow
      logger.debug(`Note: Could not clean up directory ${dirPath}: ${error.message}`);
    }
  }
}

/**
 * Create S3 service instance from environment variables
 */
export function createS3ServiceFromEnv(): S3Service | null {
  const region ='us-east-1';
  const audioBucket = process.env.S3_ARTIFACT_BUCKET;
  const videoBucket = process.env.S3_ARTIFACT_BUCKET;

  if (!audioBucket || !videoBucket) {
    logger.warn('⚠️ S3 buckets not configured. Set S3_AUDIO_BUCKET and S3_VIDEO_BUCKET environment variables to enable S3 uploads.');
    return null;
  }

  const config: S3Config = {
    region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    audioBucket,
    videoBucket,
  };

  logger.info(`🏗️ Initializing S3 service for AWS region: ${region}`);
  
  logger.info(`🔊 Audio bucket: ${audioBucket}`);
  logger.info(`📹 Video bucket: ${videoBucket}`);


  return new S3Service(config);
}

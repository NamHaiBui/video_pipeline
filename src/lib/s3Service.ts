import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger.js';
import { Upload } from '@aws-sdk/lib-storage';

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
  location: string;
  error?: string;
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
          error: `File does not exist: ${filePath}`
        };
      }

      const fileStream = fs.createReadStream(filePath);
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

      // Use Upload for multipart upload
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
        }
      });

      const result = await upload.done();
      const location = result.Location || `https://${bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
      logger.info(`✅ Successfully uploaded ${filePath} to s3://${bucket}/${key}`);
      logger.info(`📁 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      return {
        success: true,
        key,
        bucket,
        location,
      };

    } catch (error: any) {
      logger.error(`❌ Failed to upload ${filePath} to S3:`, error.message);
      return {
          success: false,
          key,
          bucket,
          location: '',
          error: error instanceof Error ? error.message : String(error)
      };
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
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'application/vnd.apple.mpegurl' 
    });

    console.log(`Uploading content to S3 bucket '${bucket}' as '${key}'...`);
    try {
        await this.s3Client.send(command);
        console.log("Upload Successful!");
        return {
            success: true,
            key,
            bucket,
            location: `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`
        };
    } catch (error) {
        if (error instanceof Error) {
            console.error(`An S3 client error occurred: ${error.message}`);
        } else {
            console.error("An unknown error occurred during S3 upload.");
        }
        return {
            success: false,
            key,
            bucket,
            location: '',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
async uploadThumbnailToS3(data: Buffer, bucket: string, key: string): Promise<S3UploadResult> {
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'image/jpeg'
    });
    console.log(`Uploading thumbnail to S3 bucket '${bucket}' as '${key}'...`);
    try {
        await this.s3Client.send(command);
        console.log("Upload Successful!");      
        return {
            success: true,
            key,
            bucket,
            location: `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`
        };
    } catch (error) {
        if (error instanceof Error) {
            console.error(`An S3 client error occurred: ${error.message}`);
        } else {
            console.error("An unknown error occurred during S3 upload.");
        }
        return {
            success: false,
            key,      
            bucket,
            location: '',
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
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, { expiresIn });
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
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key
      });
      
      await this.s3Client.send(command);
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
      const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
      });

      await this.s3Client.send(command);
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
      const { ListBucketsCommand } = await import('@aws-sdk/client-s3');
      const command = new ListBucketsCommand({});
      const result = await this.s3Client.send(command);
      
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

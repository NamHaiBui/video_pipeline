import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';

export interface S3Config {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  audioBucket: string;
  videoBucket: string;
  metadataBucket?: string;
  endpointUrl?: string; // For LocalStack support
  forcePathStyle?: boolean; // For LocalStack support
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
    // Support for LocalStack with custom endpoint
    const clientConfig: any = {
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      } : undefined, // Uses default credential chain if not provided
    };

    // Add LocalStack-specific configuration
    if (config.endpointUrl) {
      clientConfig.endpoint = config.endpointUrl;
      clientConfig.forcePathStyle = config.forcePathStyle ?? true; // LocalStack requires path-style
    }

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
          default:
            contentType = 'application/octet-stream';
        }
      }

      const command = new PutObjectCommand({
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
      });

      const result = await this.s3Client.send(command);
      const location = `https://${bucket}.s3.${this.config.region}.amazonaws.com/${key}`;

      console.log(`✅ Successfully uploaded ${filePath} to s3://${bucket}/${key}`);
      console.log(`📁 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      return {
        success: true,
        key,
        bucket,
        location,
      };

    } catch (error: any) {
      console.error(`❌ Failed to upload ${filePath} to S3:`, error.message);
      return {
        success: false,
        key,
        bucket,
        location: '',
        error: error.message
      };
    }
  }

  /**
   * Upload audio file to the audio bucket
   */
  async uploadAudioFile(filePath: string, keyPrefix?: string): Promise<S3UploadResult> {
    const filename = path.basename(filePath);
    const key = keyPrefix ? `${keyPrefix}/${filename}` : filename;
    
    console.log(`🔊 Uploading audio file to S3: ${filename}`);
    return this.uploadFile(filePath, this.config.audioBucket, key);
  }

  /**
   * Upload video file to the video bucket
   */
  async uploadVideoFile(filePath: string, keyPrefix?: string): Promise<S3UploadResult> {
    const filename = path.basename(filePath);
    const key = keyPrefix ? `${keyPrefix}/${filename}` : filename;
    
    console.log(`📹 Uploading video file to S3: ${filename}`);
    return this.uploadFile(filePath, this.config.videoBucket, key);
  }

  /**
   * Upload metadata file to the metadata bucket (or video bucket if not specified)
   */
  async uploadMetadataFile(filePath: string, keyPrefix?: string): Promise<S3UploadResult> {
    const filename = path.basename(filePath);
    const key = keyPrefix ? `${keyPrefix}/${filename}` : filename;
    const bucket = this.config.metadataBucket || this.config.videoBucket;
    
    console.log(`📄 Uploading metadata file to S3: ${filename}`);
    return this.uploadFile(filePath, bucket, key, 'application/json');
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
      console.error(`Failed to generate presigned URL for s3://${bucket}/${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Upload string content directly to S3
   */
  async uploadFileContent(
    content: string,
    bucket: string,
    key: string,
    contentType: string = 'text/plain'
  ): Promise<S3UploadResult> {
    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
        Metadata: {
          'upload-timestamp': new Date().toISOString(),
          'content-length': content.length.toString()
        }
      });

      await this.s3Client.send(command);
      const location = `https://${bucket}.s3.${this.config.region}.amazonaws.com/${key}`;

      console.log(`✅ Successfully uploaded content to s3://${bucket}/${key}`);
      
      return {
        success: true,
        key,
        bucket,
        location,
      };

    } catch (error: any) {
      console.error(`❌ Failed to upload content to S3:`, error.message);
      return {
        success: false,
        key,
        bucket,
        location: '',
        error: error.message
      };
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
      console.log(`🗑️ Deleted s3://${bucket}/${key}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to delete s3://${bucket}/${key}:`, error.message);
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
      console.error(`❌ Failed to list buckets:`, error.message);
      return [];
    }
  }

  /**
   * Delete local file after successful S3 upload
   */
  async deleteLocalFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted local file: ${filePath}`);
        return true;
      }
      return false;
    } catch (error: any) {
      console.error(`Failed to delete local file ${filePath}:`, error.message);
      return false;
    }
  }
}

/**
 * Create S3 service instance from environment variables
 */
export function createS3ServiceFromEnv(): S3Service | null {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const audioBucket = process.env.S3_AUDIO_BUCKET;
  const videoBucket = process.env.S3_VIDEO_BUCKET;
  const metadataBucket = process.env.S3_METADATA_BUCKET;

  if (!audioBucket || !videoBucket) {
    console.warn('⚠️ S3 buckets not configured. Set S3_AUDIO_BUCKET and S3_VIDEO_BUCKET environment variables to enable S3 uploads.');
    return null;
  }

  // Check for LocalStack configuration
  const isLocalStack = process.env.LOCALSTACK === 'true';
  const endpointUrl = process.env.AWS_ENDPOINT_URL || (isLocalStack ? 'http://localhost:4566' : undefined);

  const config: S3Config = {
    region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    audioBucket,
    videoBucket,
    metadataBucket,
    endpointUrl,
    forcePathStyle: isLocalStack
  };

  if (isLocalStack) {
    console.log('🧪 Initializing S3 service for LocalStack testing');
    console.log(`🔗 LocalStack endpoint: ${endpointUrl}`);
  } else {
    console.log(`🏗️ Initializing S3 service for AWS region: ${region}`);
  }
  
  console.log(`🔊 Audio bucket: ${audioBucket}`);
  console.log(`📹 Video bucket: ${videoBucket}`);
  if (metadataBucket) {
    console.log(`📄 Metadata bucket: ${metadataBucket}`);
  }

  return new S3Service(config);
}

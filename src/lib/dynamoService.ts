import { 
  DynamoDBClient, 
  CreateTableCommand, 
  DescribeTableCommand,
  ResourceNotFoundException 
} from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  UpdateCommand, 
  QueryCommand, 
  ScanCommand,
  DeleteCommand,
  PutCommandInput,
  GetCommandInput,
  UpdateCommandInput,
  QueryCommandInput,
  ScanCommandInput,
  DeleteCommandInput
} from '@aws-sdk/lib-dynamodb';
import { VideoMetadata, DownloadJob } from '../types.js';

// Add import for podcast types
import { PodcastEpisodeData, ContentAnalysisResult, AnalysisConfig } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Configuration interface for DynamoDB service
 */
export interface DynamoDBConfig {
  /** AWS region for DynamoDB */
  region: string;
  /** AWS access key ID (optional, uses default credential chain if not provided) */
  accessKeyId?: string;
  /** AWS secret access key (optional, uses default credential chain if not provided) */
  secretAccessKey?: string;
  /** Custom endpoint URL for LocalStack or other DynamoDB-compatible services */
  endpointUrl?: string;
  /** Table name for storing video metadata */
  metadataTableName: string;
  /** Table name for storing download jobs */
  jobsTableName: string;
  /** Table name for storing podcast episodes (optional) */
  podcastEpisodesTableName?: string;
}

/**
 * Standardized metadata record structure for DynamoDB storage
 */
export interface VideoMetadataRecord {
  /** Primary key: YouTube video ID */
  videoId: string;
  /** Video title */
  title: string;
  /** Channel/uploader name */
  uploader: string;
  /** Video duration in seconds */
  duration: number;
  /** Video description */
  description: string;
  /** Upload date in YYYY-MM-DD format */
  uploadDate: string;
  /** View count at time of metadata retrieval */
  viewCount: number;
  /** Like count (optional) */
  likeCount?: number;
  /** Video URL */
  webpageUrl: string;
  /** Video extractor (e.g., 'youtube') */
  extractor: string;
  /** Thumbnail URL */
  thumbnail: string;
  /** Available video formats as JSON string */
  formatsJson: string;
  /** Available thumbnails as JSON string */
  thumbnailsJson: string;
  /** Full raw metadata as JSON string for backup */
  rawMetadataJson: string;
  /** Timestamp when metadata was retrieved */
  retrievedAt: string;
  /** TTL timestamp for automatic cleanup (optional) */
  ttl?: number;
}

/**
 * Download job record structure for DynamoDB storage
 */
export interface DownloadJobRecord {
  /** Primary key: Job ID (UUID) */
  jobId: string;
  /** Video URL being processed */
  videoUrl: string;
  /** Current job status */
  status: 'pending' | 'downloading_metadata' | 'downloading' | 'merging' | 'uploading' | 'completed' | 'error';
  /** Progress information as JSON string */
  progressJson: string;
  /** Video metadata ID (foreign key to metadata table) */
  videoId?: string;
  /** File paths as JSON string */
  filePathsJson?: string;
  /** Error message if job failed */
  errorMessage?: string;
  /** Job creation timestamp */
  createdAt: string;
  /** Job completion timestamp */
  completedAt?: string;
  /** TTL timestamp for automatic cleanup */
  ttl: number;
}

/**
 * DynamoDB service class for video pipeline operations
 */
export class DynamoDBService {
  private dynamoClient: DynamoDBClient;
  private docClient: DynamoDBDocumentClient;
  private config: DynamoDBConfig;

  /**
   * Initialize DynamoDB service with configuration
   * 
   * @param config - DynamoDB configuration object
   */
  constructor(config: DynamoDBConfig) {
    this.config = config;

    // Configure DynamoDB client with optional LocalStack support
    const clientConfig: any = {
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      } : undefined, // Uses default credential chain if not provided
    };

    // Add LocalStack endpoint if specified
    if (config.endpointUrl) {
      clientConfig.endpoint = config.endpointUrl;
    }

    // Initialize clients
    this.dynamoClient = new DynamoDBClient(clientConfig);
    this.docClient = DynamoDBDocumentClient.from(this.dynamoClient);
  }

  /**
   * Ensure required DynamoDB tables exist, create them if they don't
   * This method should be called during application startup
   */
  async ensureTablesExist(): Promise<void> {
    try {
      await Promise.all([
        this.ensureMetadataTableExists(),
        this.ensureJobsTableExists()
      ]);
      console.log('✅ DynamoDB tables verified/created successfully');
    } catch (error: any) {
      console.error('❌ Failed to ensure DynamoDB tables exist:', error.message);
      throw error;
    }
  }

  /**
   * Ensure metadata table exists, create if it doesn't
   */
  private async ensureMetadataTableExists(): Promise<void> {
    try {
      await this.dynamoClient.send(new DescribeTableCommand({
        TableName: this.config.metadataTableName
      }));
      console.log(`📋 Metadata table ${this.config.metadataTableName} already exists`);
    } catch (error: any) {
      if (error instanceof ResourceNotFoundException) {
        console.log(`📋 Creating metadata table: ${this.config.metadataTableName}`);
        await this.createMetadataTable();
      } else {
        throw error;
      }
    }
  }

  /**
   * Ensure jobs table exists, create if it doesn't
   */
  private async ensureJobsTableExists(): Promise<void> {
    try {
      await this.dynamoClient.send(new DescribeTableCommand({
        TableName: this.config.jobsTableName
      }));
      console.log(`📋 Jobs table ${this.config.jobsTableName} already exists`);
    } catch (error: any) {
      if (error instanceof ResourceNotFoundException) {
        console.log(`📋 Creating jobs table: ${this.config.jobsTableName}`);
        await this.createJobsTable();
      } else {
        throw error;
      }
    }
  }

  /**
   * Create the video metadata table with appropriate schema
   */
  private async createMetadataTable(): Promise<void> {
    const command = new CreateTableCommand({
      TableName: this.config.metadataTableName,
      KeySchema: [
        {
          AttributeName: 'videoId',
          KeyType: 'HASH' // Partition key
        }
      ],
      AttributeDefinitions: [
        {
          AttributeName: 'videoId',
          AttributeType: 'S'
        }
      ],
      BillingMode: 'PAY_PER_REQUEST', // On-demand billing
      StreamSpecification: {
        StreamEnabled: false
      },
      SSESpecification: {
        Enabled: true // Enable encryption at rest
      }
    });

    await this.dynamoClient.send(command);
    console.log(`✅ Created metadata table: ${this.config.metadataTableName}`);
  }

  /**
   * Create the download jobs table with appropriate schema
   */
  private async createJobsTable(): Promise<void> {
    const command = new CreateTableCommand({
      TableName: this.config.jobsTableName,
      KeySchema: [
        {
          AttributeName: 'jobId',
          KeyType: 'HASH' // Partition key
        }
      ],
      AttributeDefinitions: [
        {
          AttributeName: 'jobId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'status',
          AttributeType: 'S'
        },
        {
          AttributeName: 'createdAt',
          AttributeType: 'S'
        }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'StatusIndex',
          KeySchema: [
            {
              AttributeName: 'status',
              KeyType: 'HASH'
            },
            {
              AttributeName: 'createdAt',
              KeyType: 'RANGE'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: {
        StreamEnabled: false
      },
      SSESpecification: {
        Enabled: true
      }
    });

    await this.dynamoClient.send(command);
    console.log(`✅ Created jobs table: ${this.config.jobsTableName}`);
  }

  /**
   * Save video metadata to DynamoDB
   * 
   * @param metadata - Raw video metadata from yt-dlp
   * @param jobId - Optional job ID for correlation
   * @returns Promise<boolean> - Success status
   */
  async saveVideoMetadata(metadata: VideoMetadata, jobId?: string): Promise<boolean> {
    try {
      // Convert metadata to DynamoDB record format
      const record: VideoMetadataRecord = {
        videoId: metadata.id,
        title: metadata.title,
        uploader: metadata.uploader,
        duration: metadata.duration,
        description: (metadata.description || '').substring(0, 2000), // Limit description length
        uploadDate: metadata.upload_date,
        viewCount: metadata.view_count || 0,
        likeCount: metadata.like_count,
        webpageUrl: metadata.webpage_url,
        extractor: metadata.extractor,
        thumbnail: metadata.thumbnail,
        formatsJson: JSON.stringify(metadata.formats || []),
        thumbnailsJson: JSON.stringify(metadata.thumbnails || []),
        // Store only essential metadata to avoid DynamoDB 400KB item size limit
        rawMetadataJson: JSON.stringify({
          id: metadata.id,
          title: metadata.title,
          uploader: metadata.uploader,
          duration: metadata.duration,
          description: (metadata.description || '').substring(0, 1000),
          upload_date: metadata.upload_date,
          view_count: metadata.view_count,
          like_count: metadata.like_count,
          webpage_url: metadata.webpage_url,
          extractor: metadata.extractor,
          thumbnail: metadata.thumbnail,
          age_limit: metadata.age_limit
        }),
        retrievedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      };

      const putCommand: PutCommandInput = {
        TableName: this.config.metadataTableName,
        Item: record,
        ConditionExpression: 'attribute_not_exists(videoId)'
      };

      await this.docClient.send(new PutCommand(putCommand));
      
      console.log(`✅ Saved metadata for video ${metadata.id} to DynamoDB`);
      if (jobId) {
        console.log(`🔗 Associated with job ${jobId}`);
      }
      
      return true;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        console.log(`ℹ️ Metadata for video ${metadata.id} already exists in DynamoDB`);
        return true; // Not an error - metadata already exists
      }
      
      console.error(`❌ Failed to save metadata for video ${metadata.id}:`, error.message);
      return false;
    }
  }

  /**
   * Retrieve video metadata from DynamoDB
   * 
   * @param videoId - YouTube video ID
   * @returns Promise<VideoMetadataRecord | null> - Metadata record or null if not found
   */
  async getVideoMetadata(videoId: string): Promise<VideoMetadataRecord | null> {
    try {
      const getCommand: GetCommandInput = {
        TableName: this.config.metadataTableName,
        Key: {
          videoId: videoId
        }
      };

      const result = await this.docClient.send(new GetCommand(getCommand));
      
      if (result.Item) {
        console.log(`✅ Retrieved metadata for video ${videoId} from DynamoDB`);
        return result.Item as VideoMetadataRecord;
      } else {
        console.log(`ℹ️ No metadata found for video ${videoId} in DynamoDB`);
        return null;
      }
    } catch (error: any) {
      console.error(`❌ Failed to retrieve metadata for video ${videoId}:`, error.message);
      return null;
    }
  }

  /**
   * Save download job to DynamoDB
   * 
   * @param job - Download job object
   * @returns Promise<boolean> - Success status
   */
  async saveDownloadJob(job: DownloadJob): Promise<boolean> {
    try {
      const record: DownloadJobRecord = {
        jobId: job.id,
        videoUrl: job.url,
        status: job.status,
        progressJson: JSON.stringify(job.progress),
        videoId: job.metadata?.id,
        filePathsJson: job.filePaths ? JSON.stringify(job.filePaths) : undefined,
        errorMessage: job.error,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString(),
        // Set TTL for 30 days from now
        ttl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
      };

      const putCommand: PutCommandInput = {
        TableName: this.config.jobsTableName,
        Item: record
      };

      await this.docClient.send(new PutCommand(putCommand));
      console.log(`✅ Saved job ${job.id} to DynamoDB with status: ${job.status}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to save job ${job.id}:`, error.message);
      return false;
    }
  }

  /**
   * Update download job status in DynamoDB
   * 
   * @param jobId - Job ID to update
   * @param status - New status
   * @param additionalData - Additional data to update
   * @returns Promise<boolean> - Success status
   */
  async updateJobStatus(
    jobId: string, 
    status: DownloadJob['status'],
    additionalData?: {
      progress?: DownloadJob['progress'];
      filePaths?: DownloadJob['filePaths'];
      error?: string;
      completedAt?: Date;
    }
  ): Promise<boolean> {
    try {
      const updateExpressions: string[] = ['#status = :status'];
      const expressionAttributeNames: Record<string, string> = {
        '#status': 'status'
      };
      const expressionAttributeValues: Record<string, any> = {
        ':status': status
      };

      if (additionalData?.progress) {
        updateExpressions.push('progressJson = :progress');
        expressionAttributeValues[':progress'] = JSON.stringify(additionalData.progress);
      }

      if (additionalData?.filePaths) {
        updateExpressions.push('filePathsJson = :filePaths');
        expressionAttributeValues[':filePaths'] = JSON.stringify(additionalData.filePaths);
      }

      if (additionalData?.error) {
        updateExpressions.push('errorMessage = :error');
        expressionAttributeValues[':error'] = additionalData.error;
      }

      if (additionalData?.completedAt) {
        updateExpressions.push('completedAt = :completedAt');
        expressionAttributeValues[':completedAt'] = additionalData.completedAt.toISOString();
      }

      const updateCommand: UpdateCommandInput = {
        TableName: this.config.jobsTableName,
        Key: {
          jobId: jobId
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'UPDATED_NEW'
      };

      await this.docClient.send(new UpdateCommand(updateCommand));
      console.log(`✅ Updated job ${jobId} status to: ${status}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to update job ${jobId}:`, error.message);
      return false;
    }
  }

  /**
   * Get download job from DynamoDB
   * 
   * @param jobId - Job ID to retrieve
   * @returns Promise<DownloadJobRecord | null> - Job record or null if not found
   */
  async getDownloadJob(jobId: string): Promise<DownloadJobRecord | null> {
    try {
      const getCommand: GetCommandInput = {
        TableName: this.config.jobsTableName,
        Key: {
          jobId: jobId
        }
      };

      const result = await this.docClient.send(new GetCommand(getCommand));
      
      if (result.Item) {
        console.log(`✅ Retrieved job ${jobId} from DynamoDB`);
        return result.Item as DownloadJobRecord;
      } else {
        console.log(`ℹ️ No job found with ID ${jobId} in DynamoDB`);
        return null;
      }
    } catch (error: any) {
      console.error(`❌ Failed to retrieve job ${jobId}:`, error.message);
      return null;
    }
  }

  /**
   * Query jobs by status
   * 
   * @param status - Job status to filter by
   * @param limit - Maximum number of results to return
   * @returns Promise<DownloadJobRecord[]> - Array of job records
   */
  async getJobsByStatus(status: DownloadJob['status'], limit: number = 50): Promise<DownloadJobRecord[]> {
    try {
      const queryCommand: QueryCommandInput = {
        TableName: this.config.jobsTableName,
        IndexName: 'StatusIndex',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': status
        },
        Limit: limit,
        ScanIndexForward: false // Sort by createdAt descending
      };

      const result = await this.docClient.send(new QueryCommand(queryCommand));
      console.log(`✅ Retrieved ${result.Items?.length || 0} jobs with status: ${status}`);
      return (result.Items || []) as DownloadJobRecord[];
    } catch (error: any) {
      console.error(`❌ Failed to query jobs by status ${status}:`, error.message);
      return [];
    }
  }

  /**
   * Clean up completed jobs older than specified days
   * 
   * @param olderThanDays - Delete jobs older than this many days
   * @returns Promise<number> - Number of jobs deleted
   */
  async cleanupOldJobs(olderThanDays: number = 7): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - (olderThanDays * 24 * 60 * 60 * 1000));
      const cutoffIso = cutoffDate.toISOString();

      // Query for completed jobs older than cutoff
      const scanCommand: ScanCommandInput = {
        TableName: this.config.jobsTableName,
        FilterExpression: '#status = :completedStatus AND createdAt < :cutoffDate',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':completedStatus': 'completed',
          ':cutoffDate': cutoffIso
        }
      };

      const result = await this.docClient.send(new ScanCommand(scanCommand));
      const jobsToDelete = result.Items || [];

      let deletedCount = 0;
      for (const job of jobsToDelete) {
        try {
          const deleteCommand: DeleteCommandInput = {
            TableName: this.config.jobsTableName,
            Key: {
              jobId: job.jobId
            }
          };

          await this.docClient.send(new DeleteCommand(deleteCommand));
          deletedCount++;
        } catch (deleteError: any) {
          console.warn(`⚠️ Failed to delete job ${job.jobId}:`, deleteError.message);
        }
      }

      console.log(`🧹 Cleaned up ${deletedCount} completed jobs older than ${olderThanDays} days`);
      return deletedCount;
    } catch (error: any) {
      console.error(`❌ Failed to cleanup old jobs:`, error.message);
      return 0;
    }
  }

  /**
   * Convert video metadata to podcast episode data and save to DynamoDB
   * 
   * @param metadata - Video metadata from yt-dlp
   * @param audioUrl - S3 URL or local path to the audio file
   * @param analysisConfig - Configuration for content analysis
   * @param videoUrl - S3 URL or local path to the video file (optional)
   * @returns Promise<string | null> - Episode ID if successful, null if failed
   */
  async convertAndSaveAsPodcastEpisode(
    metadata: VideoMetadata,
    audioUrl: string,
    analysisConfig?: AnalysisConfig,
    videoUrl?: string
  ): Promise<string | null> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return null;
      }

      // Ensure podcast episodes table exists
      await this.ensurePodcastEpisodesTableExists();

      // Convert video metadata to podcast episode data
      const episodeData = await this.convertVideoToPodcastEpisode(metadata, audioUrl, analysisConfig, videoUrl);

      // Save to DynamoDB
      const success = await this.savePodcastEpisode(episodeData);
      
      if (success) {
        console.log(`✅ Successfully converted and saved video ${metadata.id} as podcast episode`);
        return episodeData.id;
      } else {
        console.error(`❌ Failed to save podcast episode for video ${metadata.id}`);
        return null;
      }
    } catch (error: any) {
      console.error(`❌ Failed to convert video ${metadata.id} to podcast episode:`, error.message);
      return null;
    }
  }

  /**
   * Convert video metadata to podcast episode data structure
   * 
   * @param metadata - Video metadata from yt-dlp
   * @param audioUrl - S3 URL or local path to the audio file
   * @param analysisConfig - Configuration for content analysis
   * @param videoUrl - S3 URL or local path to the video file (optional)
   * @returns Promise<PodcastEpisodeData>
   */
  private async convertVideoToPodcastEpisode(
    metadata: VideoMetadata,
    audioUrl: string,
    analysisConfig?: AnalysisConfig,
    videoUrl?: string
  ): Promise<PodcastEpisodeData> {
    // Create slug from title for file naming
    const episodeTitle = this.createSlug(metadata.title);
    const podcastTitle = this.createSlug(metadata.uploader);
    
    // Format date
    const publishedDate = this.formatDate(metadata.upload_date);
    
    // Create file name
    const fileName = `${podcastTitle}/${episodeTitle}.mp3`;

    // Initialize episode data with all required attributes
    const episodeData: PodcastEpisodeData = {
      // Core identifiers
      id: uuidv4(),
      podcast_title: metadata.uploader.toLowerCase().trim(),
      episode_title: episodeTitle,
      
      // Processing status fields (default to "PENDING" when unknown)
      audio_chunking_status: "PENDING",
      chunking_status: "PENDING",
      summarization_status: "PENDING",
      transcription_status: "PENDING",
      
      // Audio and file information
      audio_url: audioUrl,
      file_name: fileName,
      
      // Content metadata
      description: (metadata.description || '').substring(0, 2000), // Limit to avoid DynamoDB size issues
      episode_downloaded: true, // Assuming it's downloaded if we have audio URL
      episode_title_details: metadata.title,
      
      // Content categorization (default to empty arrays/strings when unknown)
      genres: [],
      topics: [],
      personalities: [],
      
      // Guest and host information (default to "PENDING" when unknown)
      guest_count: 0,
      guest_description: "PENDING",
      guest_extraction_confidence: "PENDING",
      guest_names: [],
      host_description: "PENDING",
      host_name: "PENDING",
      
      // Chunking information (default to 0 when unknown)
      num_chunks: 0,
      num_removed_chunks: 0,
      
      // Data completeness flag
      partial_data: false,
      
      // Podcast metadata
      podcast_author: metadata.uploader.toLowerCase().trim(),
      published_date: publishedDate,
      rss_url: "PENDING",
      source: metadata.extractor || 'youtube',
      
      // Summary and transcript information (default to "PENDING" when unknown)
      summary_metadata: "PENDING",
      transcript_uri: "PENDING",
      
      // Optional fields for backward compatibility
      image: metadata.thumbnail,
      source_url: metadata.webpage_url,
      video_url: videoUrl, // S3 URL or local path to the video file
      episode_url: metadata.webpage_url,
      episode_time_millis: metadata.duration * 1000,
      number_of_personalities: 0,
      topic_match: true,
      original_video_metadata: JSON.stringify({
        id: metadata.id,
        title: metadata.title,
        uploader: metadata.uploader,
        duration: metadata.duration,
        upload_date: metadata.upload_date,
        view_count: metadata.view_count,
        like_count: metadata.like_count,
        webpage_url: metadata.webpage_url,
        extractor: metadata.extractor,
        thumbnail: metadata.thumbnail,
        description: (metadata.description || '').substring(0, 1000) // Limit description length
      }),
      view_count: metadata.view_count,
      like_count: metadata.like_count,
      ttl: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year TTL
    };

    // Perform content analysis if enabled
    if (analysisConfig?.enable_ai_analysis) {
      try {
        const analysis = await this.analyzeContent(
          metadata.description || metadata.title,
          metadata.title,
          analysisConfig
        );
        
        episodeData.personalities = analysis.personalities.map(p => p.toLowerCase().trim());
        episodeData.topics = analysis.matching_topics;
        episodeData.number_of_personalities = analysis.number_of_personalities;
        episodeData.topic_match = analysis.topic_match;
      } catch (error: any) {
        console.warn(`⚠️ Content analysis failed for ${metadata.id}:`, error.message);
        episodeData.partial_data = true;
      }
    }

    return episodeData;
  }

  /**
   * Save podcast episode to DynamoDB
   * 
   * @param episode - Podcast episode data
   * @returns Promise<boolean> - Success status
   */
  async savePodcastEpisode(episode: PodcastEpisodeData): Promise<boolean> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return false;
      }

      if (!episode.episode_title || !episode.podcast_title) {
        console.error('❌ Episode title or podcast title missing, both are required');
        return false;
      }

      const putCommand: PutCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        Item: episode,
        ConditionExpression: 'attribute_not_exists(id)'
      };

      await this.docClient.send(new PutCommand(putCommand));
      console.log(`✅ Saved podcast episode "${episode.episode_title}" to DynamoDB`);
      return true;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        console.log(`ℹ️ Podcast episode "${episode.episode_title}" already exists in DynamoDB`);
        return true;
      }
      
      console.error(`❌ Failed to save podcast episode "${episode.episode_title}":`, error.message);
      return false;
    }
  }

  /**
   * Get podcast episode by ID
   * 
   * @param episodeId - Episode ID
   * @returns Promise<PodcastEpisodeData | null>
   */
  async getPodcastEpisode(episodeId: string): Promise<PodcastEpisodeData | null> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return null;
      }

      const getCommand: GetCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        Key: {
          id: episodeId
        }
      };

      const result = await this.docClient.send(new GetCommand(getCommand));
      
      if (result.Item) {
        console.log(`✅ Retrieved podcast episode ${episodeId} from DynamoDB`);
        return result.Item as PodcastEpisodeData;
      } else {
        console.log(`ℹ️ No podcast episode found with ID ${episodeId}`);
        return null;
      }
    } catch (error: any) {
      console.error(`❌ Failed to retrieve podcast episode ${episodeId}:`, error.message);
      return null;
    }
  }

  /**
   * Get episodes by podcast title
   * 
   * @param podcastTitle - Podcast title to filter by
   * @param limit - Maximum number of results
   * @returns Promise<PodcastEpisodeData[]>
   */
  async getPodcastEpisodesByTitle(podcastTitle: string, limit: number = 50): Promise<PodcastEpisodeData[]> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return [];
      }

      const queryCommand: QueryCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        IndexName: 'PodcastTitleIndex',
        KeyConditionExpression: 'podcast_title = :podcastTitle',
        ExpressionAttributeValues: {
          ':podcastTitle': podcastTitle.toLowerCase().trim()
        },
        Limit: limit,
        ScanIndexForward: false // Sort by published_date descending
      };

      const result = await this.docClient.send(new QueryCommand(queryCommand));
      console.log(`✅ Retrieved ${result.Items?.length || 0} episodes for podcast: ${podcastTitle}`);
      return (result.Items || []) as PodcastEpisodeData[];
    } catch (error: any) {
      console.error(`❌ Failed to query episodes for podcast ${podcastTitle}:`, error.message);
      return [];
    }
  }

  /**
   * Get episodes by transcription status
   * 
   * @param status - Transcription status to filter by
   * @param limit - Maximum number of results
   * @returns Promise<PodcastEpisodeData[]>
   */
  async getEpisodesByTranscriptionStatus(
    status: PodcastEpisodeData['transcription_status'], 
    limit: number = 50
  ): Promise<PodcastEpisodeData[]> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return [];
      }

      const queryCommand: QueryCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        IndexName: 'TranscriptionStatusIndex',
        KeyConditionExpression: 'transcription_status = :status',
        ExpressionAttributeValues: {
          ':status': status
        },
        Limit: limit,
        ScanIndexForward: false // Sort by published_date descending
      };

      const result = await this.docClient.send(new QueryCommand(queryCommand));
      console.log(`✅ Retrieved ${result.Items?.length || 0} episodes with status: ${status}`);
      return (result.Items || []) as PodcastEpisodeData[];
    } catch (error: any) {
      console.error(`❌ Failed to query episodes by status ${status}:`, error.message);
      return [];
    }
  }

  /**
   * Update episode transcription status
   * 
   * @param episodeId - Episode ID
   * @param status - New transcription status
   * @returns Promise<boolean>
   */
  async updateTranscriptionStatus(
    episodeId: string, 
    status: PodcastEpisodeData['transcription_status']
  ): Promise<boolean> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return false;
      }

      const updateCommand: UpdateCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        Key: {
          id: episodeId
        },
        UpdateExpression: 'SET transcription_status = :status',
        ExpressionAttributeValues: {
          ':status': status
        },
        ReturnValues: 'UPDATED_NEW'
      };

      await this.docClient.send(new UpdateCommand(updateCommand));
      console.log(`✅ Updated episode ${episodeId} transcription status to: ${status}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to update episode ${episodeId} transcription status:`, error.message);
      return false;
    }
  }

  /**
   * Ensure podcast episodes table exists, create if it doesn't
   */
  private async ensurePodcastEpisodesTableExists(): Promise<void> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        throw new Error('Podcast episodes table name not configured');
      }

      await this.dynamoClient.send(new DescribeTableCommand({
        TableName: this.config.podcastEpisodesTableName
      }));
      console.log(`📋 Podcast episodes table ${this.config.podcastEpisodesTableName} already exists`);
    } catch (error: any) {
      if (error instanceof ResourceNotFoundException) {
        console.log(`📋 Creating podcast episodes table: ${this.config.podcastEpisodesTableName}`);
        await this.createPodcastEpisodesTable();
      } else {
        throw error;
      }
    }
  }

  /**
   * Create the podcast episodes table with appropriate schema
   */
  private async createPodcastEpisodesTable(): Promise<void> {
    if (!this.config.podcastEpisodesTableName) {
      throw new Error('Podcast episodes table name not configured');
    }

    const command = new CreateTableCommand({
      TableName: this.config.podcastEpisodesTableName,
      KeySchema: [
        {
          AttributeName: 'id',
          KeyType: 'HASH' // Partition key
        }
      ],
      AttributeDefinitions: [
        {
          AttributeName: 'id',
          AttributeType: 'S'
        },
        {
          AttributeName: 'podcast_title',
          AttributeType: 'S'
        },
        {
          AttributeName: 'published_date',
          AttributeType: 'S'
        },
        {
          AttributeName: 'transcription_status',
          AttributeType: 'S'
        }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'PodcastTitleIndex',
          KeySchema: [
            {
              AttributeName: 'podcast_title',
              KeyType: 'HASH'
            },
            {
              AttributeName: 'published_date',
              KeyType: 'RANGE'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        },
        {
          IndexName: 'TranscriptionStatusIndex',
          KeySchema: [
            {
              AttributeName: 'transcription_status',
              KeyType: 'HASH'
            },
            {
              AttributeName: 'published_date',
              KeyType: 'RANGE'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: {
        StreamEnabled: false
      },
      SSESpecification: {
        Enabled: true
      }
    });

    await this.dynamoClient.send(command);
    console.log(`✅ Created podcast episodes table: ${this.config.podcastEpisodesTableName}`);
  }

  /**
   * Create a URL-friendly slug from text
   * 
   * @param text - Text to convert to slug
   * @returns string - URL-friendly slug
   */
  private createSlug(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
      .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Format date string to ISO format
   * 
   * @param dateStr - Date string in YYYYMMDD format
   * @returns string - ISO date string
   */
  private formatDate(dateStr: string): string {
    try {
      // Parse YYYYMMDD format
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      const date = new Date(`${year}-${month}-${day}`);
      return date.toISOString().split('T')[0] + ' 00:00:00';
    } catch (error) {
      // Fallback to current date
      return new Date().toISOString().split('T')[0] + ' 00:00:00';
    }
  }

  /**
   * Analyze content for personalities and topics
   * This is a placeholder - you would integrate with AWS Bedrock or another AI service
   * 
   * @param content - Content to analyze
   * @param title - Content title
   * @param config - Analysis configuration
   * @returns Promise<ContentAnalysisResult>
   */
  private async analyzeContent(
    content: string,
    title: string,
    config: AnalysisConfig
  ): Promise<ContentAnalysisResult> {
    // This is a simplified implementation
    // In production, you would integrate with AWS Bedrock like in your Python example
    
    const result: ContentAnalysisResult = {
      number_of_personalities: 0,
      personalities: [],
      topic_match: true,
      matching_topics: []
    };

    // Simple keyword-based analysis as fallback
    if (config.topic_keywords && config.topic_keywords.length > 0) {
      const contentLower = content.toLowerCase();
      const titleLower = title.toLowerCase();
      
      result.matching_topics = config.topic_keywords.filter(keyword => 
        contentLower.includes(keyword.toLowerCase()) || 
        titleLower.includes(keyword.toLowerCase())
      );
      
      result.topic_match = result.matching_topics.length > 0;
    } else {
      // Extract basic topics from title/content
      const commonTopics = ['technology', 'business', 'science', 'entertainment', 'sports', 'politics', 'health'];
      const contentLower = (content + ' ' + title).toLowerCase();
      
      result.matching_topics = commonTopics.filter(topic => 
        contentLower.includes(topic)
      );
    }

    // Simple personality detection (this would be much more sophisticated in production)
    const personalityPatterns = [
      /with\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
      /featuring\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g,
      /interview\s+with\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/g
    ];

    const personalities = new Set<string>();
    personalityPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        personalities.add(match[1]);
      }
    });

    result.personalities = Array.from(personalities);
    result.number_of_personalities = result.personalities.length;

    return result;
  }
}

/**
 * Create DynamoDB service instance from environment variables
 * 
 * @returns DynamoDBService instance or null if configuration is incomplete
 */
export function createDynamoDBServiceFromEnv(): DynamoDBService | null {
  try {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const endpointUrl = process.env.AWS_ENDPOINT_URL; // For LocalStack
    
    const metadataTableName = process.env.DYNAMODB_METADATA_TABLE || 'video-pipeline-metadata';
    const jobsTableName = process.env.DYNAMODB_JOBS_TABLE || 'video-pipeline-jobs';
    const podcastEpisodesTableName = process.env.DYNAMODB_PODCAST_EPISODES_TABLE || 'PodcastEpisodeStore';

    const config: DynamoDBConfig = {
      region,
      accessKeyId,
      secretAccessKey,
      endpointUrl,
      metadataTableName,
      jobsTableName,
      podcastEpisodesTableName
    };

    const service = new DynamoDBService(config);
    console.log(`📊 DynamoDB service initialized for region: ${region}`);
    
    if (endpointUrl) {
      console.log(`🔗 Using custom endpoint: ${endpointUrl} (LocalStack mode)`);
    }

    return service;
  } catch (error: any) {
    console.error('❌ Failed to create DynamoDB service from environment:', error.message);
    return null;
  }
}

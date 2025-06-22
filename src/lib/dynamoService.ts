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
  PutCommandInput,
  GetCommandInput,
  UpdateCommandInput,
  QueryCommandInput,
  ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { VideoMetadata} from '../types.js';

// Add import for podcast types
import { PodcastEpisodeData, ContentAnalysisResult, AnalysisConfig } from '../types.js';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger.js';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { extractXMLElements, parseXML, sleep, create_slug } from './utils/utils.js';

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
  /** Table name for storing video metadata */
  metadataTableName?: string;
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

    // Configure DynamoDB client
    const clientConfig: any = {
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      } : undefined, // Uses default credential chain if not provided
    };

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
      await this.ensureMetadataTableExists();
      if (this.config.podcastEpisodesTableName) {
        await this.ensurePodcastEpisodesTableExists();
      }
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
   * Save podcast episode to DynamoDB
   * 
   * @param episode - Podcast episode data
   * @returns Promise<boolean> - Success status
   */
  async savePodcastEpisode(episode: Record<string, any>): Promise<boolean> {
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
  /**
   * Get podcast episode by ID (requires scan since ID is not in primary key)
   * 
   * @param episodeId - Episode ID
   * @returns Promise<Record<string, any> | null>
   */
  async getPodcastEpisode(episodeId: string): Promise<Record<string, any> | null> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return null;
      }

      console.log(`🔍 Attempting to retrieve episode by ID: ${episodeId}`);

      try {
        // First try Query with existing episodeUUID GSI
        const queryCommand: QueryCommandInput = {
          TableName: this.config.podcastEpisodesTableName,
          IndexName: 'episodeUUID',  // Use existing GSI name
          KeyConditionExpression: 'id = :id',
          ExpressionAttributeValues: {
            ':id': episodeId
          }
        };

        console.log(`🔧 Using Query with 'episodeUUID' GSI for ID: ${episodeId}`);
        const result = await this.docClient.send(new QueryCommand(queryCommand));
        
        if (result.Items && result.Items.length > 0) {
          console.log(`✅ Retrieved podcast episode ${episodeId} from DynamoDB using GSI`);
          return result.Items[0];
        } else {
          console.log(`ℹ️ No podcast episode found with ID ${episodeId} using GSI`);
          return null;
        }
      } catch (gsiError: any) {
        // If GSI doesn't exist, fall back to Scan
        if (gsiError.message.includes('does not have the specified index')) {
          console.log(`⚠️ GSI 'episodeUUID' not found, falling back to Scan operation`);
          
          const scanCommand: ScanCommandInput = {
            TableName: this.config.podcastEpisodesTableName,
            FilterExpression: 'id = :id',
            ExpressionAttributeValues: {
              ':id': episodeId
            }
          };

          console.log(`🔧 Using Scan with filter for ID: ${episodeId}`);
          const scanResult = await this.docClient.send(new ScanCommand(scanCommand));
          
          if (scanResult.Items && scanResult.Items.length > 0) {
            console.log(`✅ Retrieved podcast episode ${episodeId} from DynamoDB using Scan`);
            return scanResult.Items[0];
          } else {
            console.log(`ℹ️ No podcast episode found with ID ${episodeId} using Scan`);
            return null;
          }
        } else {
          throw gsiError;
        }
      }
    } catch (error: any) {
      console.error(`❌ Failed to retrieve podcast episode ${episodeId}:`, error.message);
      console.error(`🔧 Debug info:`, {
        episodeId,
        tableName: this.config.podcastEpisodesTableName,
        errorCode: error.name,
        errorMessage: error.message
      });
      return null;
    }
  }

  /**
   * Get podcast episode by composite key (podcast_title + episode_title)
   * 
   * @param podcastTitle - Podcast title
   * @param episodeTitle - Episode title
   * @returns Promise<Record<string, any> | null>
   */
  async getPodcastEpisodeByKey(podcastTitle: string, episodeTitle: string): Promise<Record<string, any> | null> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return null;
      }

      console.log(`🔍 Retrieving episode: ${podcastTitle} - ${episodeTitle}`);

      const getCommand: GetCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        Key: {
          podcast_title: podcastTitle,
          episode_title: episodeTitle
        }
      };

      const result = await this.docClient.send(new GetCommand(getCommand));
      
      if (result.Item) {
        console.log(`✅ Retrieved episode from DynamoDB`);
        return result.Item;
      } else {
        console.log(`ℹ️ No episode found with key: ${podcastTitle} - ${episodeTitle}`);
        return null;
      }
    } catch (error: any) {
      console.error(`❌ Failed to retrieve episode:`, error.message);
      return null;
    }
  }

  /**
   * Get episodes by podcast title
   * 
   * @param podcastTitle - Podcast title to filter by
   * @param limit - Maximum number of results
   * @returns Promise<Record<string, any>[]>
   */
  async getPodcastEpisodesByTitle(podcastTitle: string, limit: number = 50): Promise<Record<string, any>[]> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return [];
      }

      const queryCommand: QueryCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        KeyConditionExpression: 'podcast_title = :podcastTitle',
        ExpressionAttributeValues: {
          ':podcastTitle': podcastTitle.toLowerCase().trim()
        },
        Limit: limit,
        ScanIndexForward: false // Sort by published_date descending
      };

      const result = await this.docClient.send(new QueryCommand(queryCommand));
      console.log(`✅ Retrieved ${result.Items?.length || 0} episodes for podcast: ${podcastTitle}`);
      return result.Items || [];
    } catch (error: any) {
      console.error(`❌ Failed to query episodes for podcast ${podcastTitle}:`, error.message);
      return [];
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
        logger.info(`Checking if podcast episodes table ${this.config.podcastEpisodesTableName} exists failed: ${error.message}`);
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
          AttributeName: 'podcast_title',
          KeyType: 'HASH' // Partition key
        },
        {
          AttributeName: 'episode_title',
          KeyType: 'RANGE' // Sort key
        }
      ],
      AttributeDefinitions: [
        {
          AttributeName: 'podcast_title',
          AttributeType: 'S'
        },
        {
          AttributeName: 'episode_title',
          AttributeType: 'S'
        },
        {
          AttributeName: 'id',
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
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        },
        {
          IndexName: 'episodeUUID',  // Match existing GSI name
          KeySchema: [
            {
              AttributeName: 'id',
              KeyType: 'HASH'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
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
    console.log(`✅ Created podcast episodes table: ${this.config.podcastEpisodesTableName}`);
  }

  processEpisodeMetadata(
    videoMetadata: VideoMetadata,
    audioS3Link: string,
  ): Record<string, any> {
    logger.info("Processing episode metadata");
    
    const podcast_title = (videoMetadata.uploader || "").toLowerCase();
    const episode_title = create_slug(videoMetadata.title || "");
    const author = videoMetadata.uploader || "";
    
    const episode_data: Record<string, any> = {
      id: uuidv4(),
      episode_id: videoMetadata.id || "",
      podcast_id: create_slug(videoMetadata.uploader || ""),
      episode_title: episode_title,
      episode_title_details: videoMetadata.title || "",
      podcast_title: podcast_title,
      podcast_author: author,
      description: videoMetadata.description?.trim() || "",
      published_date: parseDate(videoMetadata.timestamp) || videoMetadata.upload_date || "",
      episode_time_millis: videoMetadata.duration ? videoMetadata.duration * 1000 : 0,
      audio_url: "",
      episode_url: videoMetadata.webpage_url || "",
      // Simplified image data for DocumentClient
      image: {
        artworkUrl600: videoMetadata.thumbnail || "",
        artworkUrl60: videoMetadata.thumbnail || "",
        artworkUrl160: videoMetadata.thumbnail || ""
      },
      // Simplified arrays for DocumentClient
      genres: videoMetadata.tags || [],
      country: videoMetadata.country || "",
      episode_guid: "",
      file_name: audioS3Link,
      source: "youtube",
      video_file_name: "PENDING",
      rss_url: "",
      
      // Status fields
      transcription_status: "PENDING",
      audio_chunking_status: "PENDING",
      chunking_status: "PENDING",
      summarization_status: "PENDING",
      quote_status: "PENDING",
      quotes_audio_status: "PENDING",
      quotes_video_status: "PENDING",
      video_chunking_status: "PENDING",
      
      // Analysis fields with defaults - simplified for DocumentClient
      personalities: [],
      topics: [],
      guest_count: 0,
      guest_description: [],
      guest_extraction_confidence: "PENDING",
      guest_names: [],
      
      // Processing fields
      num_chunks: 0,
      num_quotes: 0,
      num_removed_chunks: 0,
      summary_metadata: {
        topic_metadata: {
          start: [],
          end: [],
          topics: [],
          chunk_nos: []
        },
        summary_transcript_file_name: "",
        summary_duration: "0"
      },
      transcript_uri: "PENDING",
      
      // Download status
      episode_downloaded: true, 
      partial_data: false
    };

    logger.info(`Processed episode metadata for: ${episode_data.episode_title}`);
    return episode_data;
  }

  /**
   * Update episode with video S3 key
   * 
   * @param episodeId - Episode ID to update
   * @param videoS3Key - S3 key for the video (not the full URL)
   * @returns Promise<boolean> - Success status
   */
  async updateEpisodeVideoLink(episodeId: string, videoS3Key: string): Promise<boolean> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return false;
      }

      // First, find the episode by ID to get the composite key
      const episode = await this.getPodcastEpisode(episodeId);
      if (!episode) {
        console.error(`❌ Episode ${episodeId} not found in database`);
        return false;
      }

      // Extract the composite key values
      const podcastTitle = episode.podcast_title;
      const episodeTitle = episode.episode_title;

      console.log(`🔄 Updating episode video link for: ${podcastTitle} - ${episodeTitle}`);

      // Now update the episode using the composite key
      const updateCommand: UpdateCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        Key: {
          podcast_title: podcastTitle,
          episode_title: episodeTitle
        },
        UpdateExpression: 'SET video_file_name = :videoS3Key',
        ExpressionAttributeValues: {
          ':videoS3Key': videoS3Key
        },
        ReturnValues: 'UPDATED_NEW'
      };

      const result = await this.docClient.send(new UpdateCommand(updateCommand));
      console.log(`✅ Updated episode ${episodeId} with video S3 key: ${videoS3Key}`);
      console.log(`📝 Updated attributes:`, result.Attributes);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to update episode ${episodeId} with video key:`, error.message);
      console.error(`🔧 Debug info - Episode ID: ${episodeId}, Table: ${this.config.podcastEpisodesTableName}`);
      return false;
    }
  }

  /**
   * Convert DynamoDB formatted episode data to plain JavaScript object
   * 
   * @param episode - Episode data in DynamoDB format
   * @returns Plain JavaScript object
   */
  static convertFromDynamoFormat(episode: PodcastEpisodeData): any {
    return {
      ...episode,
      genres: episode.genres.map(g => g.S),
      personalities: episode.personalities.map(p => p.S),
      topics: episode.topics.map(t => t.S),
      guest_names: episode.guest_names.map(g => g.M.S.S),
      image: {
        artworkUrl600: episode.image.artworkUrl600.S,
        artworkUrl60: episode.image.artworkUrl60.S,
        artworkUrl160: episode.image.artworkUrl160.S
      },
      summary_metadata: {
        topic_metadata: {
          start: episode.summary_metadata.topic_metadata.M.start.L.map(s => s.S),
          end: episode.summary_metadata.topic_metadata.M.end.L.map(e => e.S),
          topics: episode.summary_metadata.topic_metadata.M.topics.L.map(t => t.S),
          chunk_nos: episode.summary_metadata.topic_metadata.M.chunk_nos.L.map(c => c.S)
        },
        summary_transcript_file_name: episode.summary_metadata.summary_transcript_file_name.S,
        summary_duration: episode.summary_metadata.summary_duration.S
      }
    };
  }

  /**
   * Convert plain JavaScript object to DynamoDB format
   * 
   * @param episode - Plain JavaScript episode object
   * @returns Episode data in DynamoDB format
   */
  static convertToDynamoFormat(episode: any): Partial<PodcastEpisodeData> {
    return {
      ...episode,
      genres: (episode.genres || []).map((g: string) => ({ S: g })),
      personalities: (episode.personalities || []).map((p: string) => ({ S: p })),
      topics: (episode.topics || []).map((t: string) => ({ S: t })),
      guest_names: (episode.guest_names || []).map((g: string) => ({ 
        M: { S: { S: g } } 
      })),
      image: episode.image ? {
        // Handle both plain string URLs and already formatted DynamoDB structures
        artworkUrl600: { S: typeof episode.image.artworkUrl600 === 'string' ? episode.image.artworkUrl600 : (episode.image.artworkUrl600?.S || "") },
        artworkUrl60: { S: typeof episode.image.artworkUrl60 === 'string' ? episode.image.artworkUrl60 : (episode.image.artworkUrl60?.S || "") },
        artworkUrl160: { S: typeof episode.image.artworkUrl160 === 'string' ? episode.image.artworkUrl160 : (episode.image.artworkUrl160?.S || "") }
      } : {
        artworkUrl600: { S: "" },
        artworkUrl60: { S: "" },
        artworkUrl160: { S: "" }
      }
    };
  }

  /**
   * Process episodes from podcast feed with AI analysis
   * 
   * @param fetch_itunes - Whether to fetch iTunes metadata
   * @param episode - Episode metadata from video source
   * @param topic_keywords - Array of topic keywords to match
   * @returns Promise<PodcastEpisodeData | undefined>
   */
  async processEpisodeMetadataWithAnalysis(
    fetch_itunes: boolean,
    episode: VideoMetadata,
    topic_keywords: string[] = []
  ): Promise<PodcastEpisodeData | undefined> {
    logger.info("Processing new episodes with analysis");
    const podcast_title = episode.title?.toLowerCase() || "";
    const author = episode.uploader?.toLowerCase() || "";
    const title = episode.title?.toLowerCase() || "";
    const summary = episode.description?.toLowerCase() || ""; 
    let is_partial = false;

    const episode_data: Partial<PodcastEpisodeData> = {
      id: uuidv4(),
      episode_title_details: episode.title?.toLowerCase() || "",
      podcast_title: podcast_title,
      description: episode.description?.trim() || "",
      audio_url: episode.formats?.[0]?.url?.trim() || "",
      transcription_status: "new",
      published_date: parseDate(episode.upload_date),
      podcast_author: author || "",
      episode_downloaded: false,
    };

    try {
      episode_data.episode_id = episode.id;
      episode_data.podcast_id = episode.uploader?.toLowerCase();
      episode_data.episode_guid = episode.id;
      // Format image according to DynamoDB structure
      episode_data.image = {
        artworkUrl600: { S: episode.thumbnail || "" },
        artworkUrl60: { S: episode.thumbnail || "" },
        artworkUrl160: { S: episode.thumbnail || "" }
      };
      episode_data.episode_url = episode.webpage_url;
      episode_data.genres = (episode.tags || []).map((tag: string) => ({ S: tag }));
      episode_data.country = episode.country;
      episode_data.episode_time_millis = episode.duration ? episode.duration * 1000 : 0;
    } catch (error: any) {
      logger.error(`Error while processing episode data: ${error.message}`);
      is_partial = true;
      await this.insertUnfoundUrl(
        podcast_title,
        episode_data.episode_title_details!,
        error.message,
        "episode_details_processing_failed"
      );
    }

    logger.info("Analyzing topic and personalities");
    let analysis: ContentAnalysisResult;
    
    try {
      if (topic_keywords.length > 0) {
        analysis = await this.analyzePodcastSummaryCohere(summary, topic_keywords, title);
      } else {
        analysis = await this.analyzePodcastSummaryCohereNonTopics(summary, title);
      }
    } catch (error: any) {
      logger.error(`Error occurred while performing analysis: ${error.message}`);
      await this.insertUnfoundUrl(
        podcast_title,
        episode_data.episode_title_details!,
        error.message,
        "episode_analysis_failed"
      );
      logger.info(`Skipping episode: ${episode.title?.toLowerCase()}`);
      return;
    }

    // Converting the episode title to slugs
    const episode_title = create_slug(episode.title?.toLowerCase() || "");
    const personalities = analysis.personalities.map(person => person.toLowerCase().trim());
    
    let file_name = podcast_title.replace(/\s+/g, "-");
    file_name = create_slug(file_name);
    file_name += `/${episode_title}`;
    
    episode_data.file_name = `${file_name}.mp3`;
    // Format personalities and topics according to DynamoDB structure
    episode_data.personalities = personalities.map((person: string) => ({ S: person }));
    episode_data.topics = analysis.matching_topics.map((topic: string) => ({ S: topic }));
    episode_data.episode_title = episode_title;
    episode_data.source = "youtube";
    episode_data.partial_data = is_partial;
    
    // Set default values for required fields
    episode_data.audio_chunking_status = "PENDING";
    episode_data.chunking_status = "PENDING";
    episode_data.summarization_status = "PENDING";
    episode_data.quote_status = "PENDING";
    episode_data.quotes_audio_status = "PENDING";
    episode_data.quotes_video_status = "";
    episode_data.video_chunking_status = "";
    episode_data.guest_count = analysis.number_of_personalities;
    // Format guest description according to DynamoDB structure
    episode_data.guest_description = [];
    episode_data.guest_extraction_confidence = "PENDING";
    // Format guest names according to DynamoDB structure
    episode_data.guest_names = personalities.map((person: string) => ({ 
      M: { S: { S: person } } 
    }));
    episode_data.num_chunks = 0;
    episode_data.num_quotes = 0;
    episode_data.num_removed_chunks = 0;
    // Format summary metadata according to DynamoDB structure
    episode_data.summary_metadata = {
      topic_metadata: {
        M: {
          start: { L: [] },
          end: { L: [] },
          topics: { L: [] },
          chunk_nos: { L: [] }
        }
      },
      summary_transcript_file_name: { S: "" },
      summary_duration: { S: "0" }
    };
    episode_data.transcript_uri = "PENDING";
    episode_data.transcription_status = "PENDING";
    episode_data.video_file_name = "";
    episode_data.rss_url = "";

    logger.info(`Episode to add to the database: ${JSON.stringify(episode_data)}`);
    return episode_data as PodcastEpisodeData;
  }

  /**
   * Analyze podcast content using Cohere AI for topic and personality extraction
   * 
   * @param summary - Episode description/summary
   * @param topic_keywords - Keywords to match against
   * @param title - Episode title
   * @returns Promise<ContentAnalysisResult>
   */
  async analyzePodcastSummaryCohere(
    summary: string, 
    topic_keywords: string[], 
    title: string
  ): Promise<ContentAnalysisResult> {
    logger.info("Starting Cohere analysis with topic matching");
    
    const prompt = `
    Analyze the following podcast episode and extract:
    1. Number of personalities/people mentioned
    2. List of personality names (people, hosts, guests)
    3. Whether any of these topics are discussed: ${topic_keywords.join(', ')}
    4. Which specific topics from the list are mentioned

    Episode Title: ${title}
    Episode Description: ${summary}

    Respond in JSON format:
    {
      "number_of_personalities": <number>,
      "personalities": ["name1", "name2", ...],
      "topic_match": <true/false>,
      "matching_topics": ["topic1", "topic2", ...]
    }
    `;

    try {
      const bedrockClient = new BedrockRuntimeClient({ 
        region: process.env.AWS_REGION || 'us-east-1' 
      });

      const command = new InvokeModelCommand({
        modelId: 'cohere.command-text-v14',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          prompt: prompt,
          max_tokens: 500,
          temperature: 0.3,
          p: 0.75,
          k: 0,
          stop_sequences: [],
          return_likelihoods: 'NONE'
        })
      });

      const response = await bedrockClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
      // Extract JSON from the response text
      const responseText = responseBody.generations[0].text.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        return {
          number_of_personalities: analysisResult.number_of_personalities || 0,
          personalities: analysisResult.personalities || [],
          topic_match: analysisResult.topic_match || false,
          matching_topics: analysisResult.matching_topics || []
        };
      } else {
        throw new Error('No valid JSON found in response');
      }
    } catch (error: any) {
      logger.error(`Cohere analysis failed: ${error.message}`);
      // Return default values
      return {
        number_of_personalities: 0,
        personalities: [],
        topic_match: false,
        matching_topics: []
      };
    }
  }

  /**
   * Analyze podcast content using Cohere AI without specific topic matching
   * 
   * @param summary - Episode description/summary
   * @param title - Episode title
   * @returns Promise<ContentAnalysisResult>
   */
  async analyzePodcastSummaryCohereNonTopics(
    summary: string, 
    title: string
  ): Promise<ContentAnalysisResult> {
    logger.info("Starting Cohere analysis without topic matching");
    
    const prompt = `
    Analyze the following podcast episode and extract:
    1. Number of personalities/people mentioned
    2. List of personality names (people, hosts, guests)
    3. Main topics discussed (up to 5 most important topics)

    Episode Title: ${title}
    Episode Description: ${summary}

    Respond in JSON format:
    {
      "number_of_personalities": <number>,
      "personalities": ["name1", "name2", ...],
      "topic_match": true,
      "matching_topics": ["topic1", "topic2", ...]
    }
    `;

    try {
      const bedrockClient = new BedrockRuntimeClient({ 
        region: process.env.AWS_REGION || 'us-east-1' 
      });

      const command = new InvokeModelCommand({
        modelId: 'cohere.command-text-v14',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          prompt: prompt,
          max_tokens: 500,
          temperature: 0.3,
          p: 0.75,
          k: 0,
          stop_sequences: [],
          return_likelihoods: 'NONE'
        })
      });

      const response = await bedrockClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
      // Extract JSON from the response text
      const responseText = responseBody.generations[0].text.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        return {
          number_of_personalities: analysisResult.number_of_personalities || 0,
          personalities: analysisResult.personalities || [],
          topic_match: true, // Always true for non-topic analysis
          matching_topics: analysisResult.matching_topics || []
        };
      } else {
        throw new Error('No valid JSON found in response');
      }
    } catch (error: any) {
      logger.error(`Cohere analysis failed: ${error.message}`);
      // Return default values
      return {
        number_of_personalities: 0,
        personalities: [],
        topic_match: false,
        matching_topics: []
      };
    }
  }

  /**
   * Insert unfound URL for tracking failed processing
   * 
   * @param podcast_title - Podcast title
   * @param episode_title - Episode title
   * @param error_message - Error message
   * @param error_type - Type of error
   */
  private async insertUnfoundUrl(
    podcast_title: string, 
    episode_title: string, 
    error_message: string, 
    error_type: string
  ): Promise<void> {
    try {
      logger.info(`Recording failed processing: ${error_type} for ${podcast_title} - ${episode_title}`);
      // You can implement this to store failed processing attempts in a separate table
      // for monitoring and debugging purposes
    } catch (error: any) {
      logger.error(`Failed to insert unfound URL record: ${error.message}`);
    }
  }

  /**
   * Debug function to list all episodes in the table (use sparingly)
   * 
   * @param limit - Maximum number of items to return
   * @returns Promise<Record<string, any>[]>
   */
  async debugListAllEpisodes(limit: number = 10): Promise<Record<string, any>[]> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return [];
      }

      const scanCommand: ScanCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        Limit: limit,
        ProjectionExpression: 'id, podcast_title, episode_title, episode_title_details'
      };

      const result = await this.docClient.send(new ScanCommand(scanCommand));
      
      console.log(`🔍 Found ${result.Items?.length || 0} episodes in database:`);
      if (result.Items) {
        result.Items.forEach((item, index) => {
          console.log(`  ${index + 1}. ID: ${item.id}, Podcast: ${item.podcast_title}, Episode: ${item.episode_title}`);
        });
      }
      
      return result.Items || [];
    } catch (error: any) {
      console.error(`❌ Failed to list episodes:`, error.message);
      return [];
    }
  }

  /**
   * Check if episode exists by searching for partial ID match
   * 
   * @param partialId - Partial episode ID to search for
   * @returns Promise<Record<string, any>[]>
   */
  async findEpisodesByPartialId(partialId: string): Promise<Record<string, any>[]> {
    try {
      if (!this.config.podcastEpisodesTableName) {
        console.error('❌ Podcast episodes table name not configured');
        return [];
      }

      const scanCommand: ScanCommandInput = {
        TableName: this.config.podcastEpisodesTableName,
        FilterExpression: 'contains(id, :partialId)',
        ExpressionAttributeValues: {
          ':partialId': partialId
        },
        ProjectionExpression: 'id, podcast_title, episode_title'
      };

      const result = await this.docClient.send(new ScanCommand(scanCommand));
      
      console.log(`🔍 Found ${result.Items?.length || 0} episodes matching '${partialId}':`);
      if (result.Items) {
        result.Items.forEach((item, index) => {
          console.log(`  ${index + 1}. ID: ${item.id}, Podcast: ${item.podcast_title}, Episode: ${item.episode_title}`);
        });
      }
      
      return result.Items || [];
    } catch (error: any) {
      console.error(`❌ Failed to search episodes:`, error.message);
      return [];
    }
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
    
    const podcastEpisodesTableName = process.env.DYNAMODB_PODCAST_EPISODES_TABLE || 'PodcastEpisodeStoreTest';

    const config: DynamoDBConfig = {
      region,
      accessKeyId,
      secretAccessKey,
      podcastEpisodesTableName
    };

    const service = new DynamoDBService(config);
    console.log(`📊 DynamoDB service initialized for region: ${region}`);
    
    return service;
  } catch (error: any) {
    console.error('❌ Failed to create DynamoDB service from environment:', error.message);
    return null;
  }
}

/**
 * Parses various date formats into a standardized ISO string
 * 
 * @param published - Date value in various formats (string, Date object, timestamp)
 * @returns Formatted date string in ISO format or undefined if parsing fails
 */
function parseDate(published: any): string | undefined {
  if (!published) {
    return undefined;
  }
  
  try {
    let date: Date;
    
    if (published instanceof Date) {
      date = published;
    } else if (typeof published === 'number') {
      // Handle timestamp - determine if it's seconds or milliseconds
      // Timestamps > 1e12 are likely milliseconds, smaller ones are seconds
      if (published > 1e12) {
        // Milliseconds timestamp
        date = new Date(published);
      } else {
        // Seconds timestamp (Unix timestamp)
        date = new Date(published * 1000);
      }
    } else if (typeof published === 'string') {
      // Check if it's a valid date string
      if (published.trim() === '') {
        return undefined;
      }
      
      // Handle YouTube date format (YYYYMMDD)
      if (/^\d{8}$/.test(published)) {
        const year = published.substring(0, 4);
        const month = published.substring(4, 6);
        const day = published.substring(6, 8);
        date = new Date(`${year}-${month}-${day}`);
      } else if (/^\d+$/.test(published)) {
        // Handle string numbers (timestamps)
        const timestamp = parseInt(published);
        if (timestamp > 1e12) {
          // Milliseconds timestamp
          date = new Date(timestamp);
        } else {
          // Seconds timestamp (Unix timestamp)
          date = new Date(timestamp * 1000);
        }
      } else {
        // Try parsing the string normally
        date = new Date(published);
      }
    } else {
      return undefined;
    }
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return undefined;
    }
    
    // Return formatted date string in YYYY-MM-DD HH:mm:ss format
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    logger.error(`Failed to parse date: ${published}`, error as Error);
    return undefined;
  }
}


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
  PutCommandInput,
  GetCommandInput,
  UpdateCommandInput,
  QueryCommandInput} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { VideoMetadata, PodcastEpisodeData, ContentAnalysisResult, AnalysisConfig } from '../types.js';

/**
 * Configuration interface for Podcast DynamoDB service
 */
export interface PodcastDynamoDBConfig {
  /** AWS region for DynamoDB */
  region: string;
  /** AWS access key ID (optional) */
  accessKeyId?: string;
  /** AWS secret access key (optional) */
  secretAccessKey?: string;
  /** Custom endpoint URL for LocalStack */
  endpointUrl?: string;
  /** Table name for storing podcast episodes */
  episodeTableName: string;
}

/**
 * Service for managing podcast episodes converted from video metadata
 */
export class PodcastService {
  private dynamoClient: DynamoDBClient;
  private docClient: DynamoDBDocumentClient;
  private config: PodcastDynamoDBConfig;

  constructor(config: PodcastDynamoDBConfig) {
    this.config = config;

    const clientConfig: any = {
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      } : undefined,
    };

    if (config.endpointUrl) {
      clientConfig.endpoint = config.endpointUrl;
    }

    this.dynamoClient = new DynamoDBClient(clientConfig);
    this.docClient = DynamoDBDocumentClient.from(this.dynamoClient);
  }

  /**
   * Ensure the podcast episodes table exists
   */
  async ensureEpisodeTableExists(): Promise<void> {
    try {
      await this.dynamoClient.send(new DescribeTableCommand({
        TableName: this.config.episodeTableName
      }));
      console.log(`📋 Episode table ${this.config.episodeTableName} already exists`);
    } catch (error: any) {
      if (error instanceof ResourceNotFoundException) {
        console.log(`📋 Creating episode table: ${this.config.episodeTableName}`);
        await this.createEpisodeTable();
      } else {
        throw error;
      }
    }
  }

  /**
   * Create the podcast episodes table
   */
  private async createEpisodeTable(): Promise<void> {
    const command = new CreateTableCommand({
      TableName: this.config.episodeTableName,
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
    console.log(`✅ Created episode table: ${this.config.episodeTableName}`);
  }

  /**
   * Convert video metadata to podcast episode data
   * 
   * @param metadata - Video metadata from yt-dlp
   * @param analysisConfig - Configuration for content analysis
   * @param audioUrl - URL or path to the audio file
   * @returns Promise<PodcastEpisodeData>
   */
  async convertVideoToPodcastEpisode(
    metadata: VideoMetadata, 
    audioUrl: string,
    analysisConfig?: AnalysisConfig
  ): Promise<PodcastEpisodeData> {
    try {
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
        description: (metadata.description || '').substring(0, 1000), // Reduced to 1000 chars to fit DynamoDB limits
        episode_downloaded: true, // Assuming it's downloaded if we have audio URL
        episode_title_details: metadata.title.substring(0, 500), // Limit title details
        
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
        
        // Optional fields for backward compatibility and additional metadata
        image: metadata.thumbnail,
        source_url: metadata.webpage_url,
        episode_url: metadata.webpage_url,
        episode_time_millis: metadata.duration * 1000,
        number_of_personalities: 0,
        topic_match: true,
        // Store only essential metadata to reduce size and avoid DynamoDB 400KB limit
        original_video_metadata: JSON.stringify({
          id: metadata.id,
          title: metadata.title.substring(0, 200), // Limit title length
          uploader: metadata.uploader,
          duration: metadata.duration,
          upload_date: metadata.upload_date,
          webpage_url: metadata.webpage_url,
          thumbnail: metadata.thumbnail,
          extractor: metadata.extractor
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
    } catch (error: any) {
      console.error(`❌ Failed to convert video ${metadata.id} to podcast episode:`, error.message);
      throw error;
    }
  }

  /**
   * Save podcast episode to DynamoDB
   * 
   * @param episode - Podcast episode data
   * @returns Promise<boolean> - Success status
   */
  async insertEpisode(episode: PodcastEpisodeData): Promise<boolean> {
    try {
      if (!episode.episode_title || !episode.podcast_title) {
        console.error('Episode title or podcast title missing, both are required');
        return false;
      }

      const putCommand: PutCommandInput = {
        TableName: this.config.episodeTableName,
        Item: episode,
        ConditionExpression: 'attribute_not_exists(id)'
      };

      await this.docClient.send(new PutCommand(putCommand));
      console.log(`✅ Saved episode "${episode.episode_title}" to DynamoDB`);
      return true;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        console.log(`ℹ️ Episode "${episode.episode_title}" already exists in DynamoDB`);
        return true;
      }
      
      console.error(`❌ Failed to save episode "${episode.episode_title}":`, error.message);
      return false;
    }
  }

  /**
   * Get podcast episode by ID
   * 
   * @param episodeId - Episode ID
   * @returns Promise<PodcastEpisodeData | null>
   */
  async getEpisode(episodeId: string): Promise<PodcastEpisodeData | null> {
    try {
      const getCommand: GetCommandInput = {
        TableName: this.config.episodeTableName,
        Key: {
          id: episodeId
        }
      };

      const result = await this.docClient.send(new GetCommand(getCommand));
      
      if (result.Item) {
        console.log(`✅ Retrieved episode ${episodeId} from DynamoDB`);
        return result.Item as PodcastEpisodeData;
      } else {
        console.log(`ℹ️ No episode found with ID ${episodeId}`);
        return null;
      }
    } catch (error: any) {
      console.error(`❌ Failed to retrieve episode ${episodeId}:`, error.message);
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
  async getEpisodesByPodcast(podcastTitle: string, limit: number = 50): Promise<PodcastEpisodeData[]> {
    try {
      const queryCommand: QueryCommandInput = {
        TableName: this.config.episodeTableName,
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
      const queryCommand: QueryCommandInput = {
        TableName: this.config.episodeTableName,
        IndexName: 'TranscriptionStatusIndex',
        KeyConditionExpression: 'transcription_status = :status',
        ExpressionAttributeValues: {
          ':status': status
        },
        Limit: limit,
        ScanIndexForward: false
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
      const updateCommand: UpdateCommandInput = {
        TableName: this.config.episodeTableName,
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
      console.error(`❌ Failed to update episode ${episodeId} status:`, error.message);
      return false;
    }
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
 * Create podcast service instance from environment variables
 * 
 * @returns PodcastService instance or null if configuration incomplete
 */
export function createPodcastServiceFromEnv(): PodcastService | null {
  try {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const endpointUrl = process.env.AWS_ENDPOINT_URL;
    
    const episodeTableName = process.env.PODCAST_EPISODE_TABLE || 'PodcastEpisodeStore';

    const config: PodcastDynamoDBConfig = {
      region,
      accessKeyId,
      secretAccessKey,
      endpointUrl,
      episodeTableName
    };

    const service = new PodcastService(config);
    console.log(`🎙️ Podcast service initialized for region: ${region}`);
    
    if (endpointUrl) {
      console.log(`🔗 Using custom endpoint: ${endpointUrl} (LocalStack mode)`);
    }

    return service;
  } catch (error: any) {
    console.error('❌ Failed to create podcast service from environment:', error.message);
    return null;
  }
}

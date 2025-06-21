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
  QueryCommandInput,
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
      logger.info(`Checking if podcast episodes table ${this.config.podcastEpisodesTableName} exists failed: ${error.message}`);
    }
  }

  processEpisodeMetadata(
    videoMetadata: VideoMetadata,
    audioS3Link: string,
  ): PodcastEpisodeData {
    logger.info("Processing episode metadata");
    
    const podcast_title = create_slug(videoMetadata.uploader || "");
    const episode_title = create_slug(videoMetadata.title || "");
    const author = videoMetadata.uploader || "";
    
    // Generate file name structure using slugs
    const file_name = `${podcast_title}/${episode_title}`;
    
    const episode_data: PodcastEpisodeData = {
      id: uuidv4(),
      episode_id: videoMetadata.id,
      podcast_id: create_slug(videoMetadata.uploader || ""),
      episode_title: episode_title,
      episode_title_details: videoMetadata.title || "",
      podcast_title: podcast_title,
      podcast_author: author,
      description: videoMetadata.description?.trim() || "",
      published_date: parseDate(videoMetadata.upload_date)||videoMetadata.upload_date || "",
      episode_time_millis: videoMetadata.duration ? videoMetadata.duration * 1000 : 0,
      audio_url: audioS3Link,
      episode_url: videoMetadata.webpage_url || "",
      image: JSON.stringify(videoMetadata.thumbnail || ""),
      genres: videoMetadata.tags || [],
      country: videoMetadata.country || "",
      episode_guid: videoMetadata.id,
      file_name: `${file_name}.mp3`,
      source: "youtube",
      video_url: "",
      rss_url: "",
      
      // Status fields
      transcription_status: "new",
      audio_chunking_status: "PENDING",
      chunking_status: "PENDING",
      summarization_status: "PENDING",
      quotes_audio_status: "PENDING",
      
      // Analysis fields with defaults
      personalities: [],
      topics: [],
      guest_count: 0,
      guest_description: "PENDING",
      guest_extraction_confidence: "PENDING",
      guest_names: [],
      host_description: "PENDING",
      host_name: "PENDING",
      number_of_personalities: 0,
      topic_match: false,
      
      // Processing fields
      num_chunks: 0,
      num_removed_chunks: 0,
      summary_metadata: "PENDING",
      transcript_uri: "PENDING",
      
      // Download status
      episode_downloaded: true, 
      partial_data: false
    };

    logger.info(`Processed episode metadata for: ${episode_data.episode_title}`);
    return episode_data;
  }

  /**
   * Update episode with video S3 link
   * 
   * @param episodeId - Episode ID to update
   * @param videoS3Link - S3 link for the video
   * @returns Promise<boolean> - Success status
   */
  async updateEpisodeVideoLink(episodeId: string, videoS3Link: string): Promise<boolean> {
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
        UpdateExpression: 'SET video_url = :videoUrl',
        ExpressionAttributeValues: {
          ':videoUrl': videoS3Link
        },
        ReturnValues: 'UPDATED_NEW'
      };

      await this.docClient.send(new UpdateCommand(updateCommand));
      console.log(`✅ Updated episode ${episodeId} with video S3 link`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to update episode ${episodeId} with video link:`, error.message);
      return false;
    }
  }

// Augmented method to process episode metadata with analysis  
  /**
   * Process episodes from podcast feed
   * 
   * @param episode - Singular Episode
   * @param podcast_feed - Podcast feed metadata
   * @param topic_keywords - Array of topic keywords to match
   * @param person_keywords - Array of person keywords to match
   */
  async processEpisodeMetadataWithAnalysis(
    fetch_itunes: boolean,
    episode: VideoMetadata,
    topic_keywords: string[] = []
  ): Promise<PodcastEpisodeData | undefined> {
      logger.info("Processing new episodes");
      const podcast_title = episode.title?.toLowerCase() || "";
      const author = episode.uploader?.toLowerCase() || "";
      const title = episode.title?.toLowerCase() || "";
      const summary = episode.description?.toLowerCase() || ""; 
      // const rss_link =  await this.getRSSLink(podcast_title);
      let is_partial = false;

      const episode_data: Partial<PodcastEpisodeData> = {
        id: uuidv4(),
        episode_title_details: episode.title?.toLowerCase() || "",
        podcast_title: podcast_title,
        description: episode.description?.trim() || "",
        audio_url: episode.enclosures?.[0]?.href?.trim() || "",
        transcription_status: "new",
        published_date: parseDate(episode.published),
        // rss_url: rss_link || "",
        podcast_author: author || "",
        episode_downloaded: false,
      };

      try {
        // logger.info("Trying to fetch metadata from iTunes");
        // if (!fetch_itunes) {
        //   logger.info("Skipping iTunes metadata fetch as per configuration");
        //   const episode_metadata = await this.getEpisodeMetadata(title.trim(), "itunes");
        //   return;
        // }
        
        // if (!episode_metadata) {
        //   is_partial = true;
        //   logger.info("Episode information not found");
        //   await this.insertUnfoundUrl(
        //     podcast_title, 
        //     episode_data.episode_title_details!, 
        //     `No episode found for ${title}`, 
        //     "episode_details_not_found"
        //   );
        // } else {
          episode_data.episode_id = episode.id;
          episode_data.podcast_id = episode.uploader?.toLowerCase() || "";
          episode_data.episode_guid = episode.episode_guid;
          episode_data.image = JSON.stringify(episode.thumbnail);
          episode_data.episode_url = episode.webpage_url;
          episode_data.genres = episode.tags;
          episode_data.country = episode.country;
          episode_data.episode_time_millis = episode.duration ? episode.duration * 1000 : 0; 
        // }
      } catch (error: any) {
        logger.error(`Error while inserting data, so going forward and saving partial data.\nException: ${error.message}`);
        is_partial = true;
        await this.insertUnfoundUrl(
          podcast_title,
          episode_data.episode_title_details!,
          error.message,
          "episode_details_not_found"
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
        logger.info(`Skipping to insert ${episode.title?.toLowerCase()}`);
        return;
      }

      // Converting the episode title to slugs
      const episode_title = create_slug(episode.title?.toLowerCase() || "");
      const personalities = analysis.personalities.map(person => person.toLowerCase().trim());
      
      let file_name = podcast_title.replace(/\s+/g, "-");
      file_name = create_slug(file_name);
      file_name += `/${episode_title}`;
      
      episode_data.file_name = `${file_name}.mp3`;
      episode_data.personalities = personalities;
      episode_data.topics = analysis.matching_topics;
      episode_data.episode_title = episode_title;
      episode_data.source = "itunes";
      episode_data.partial_data = is_partial;
      
      // Set default values for required fields
      episode_data.audio_chunking_status = "PENDING";
      episode_data.chunking_status = "PENDING";
      episode_data.summarization_status = "PENDING";
      episode_data.quotes_audio_status = "PENDING";
      episode_data.guest_count = analysis.number_of_personalities;
      episode_data.guest_description = "PENDING";
      episode_data.guest_extraction_confidence = "PENDING";
      episode_data.guest_names = personalities;
      episode_data.host_description = "PENDING";
      episode_data.host_name = "PENDING";
      episode_data.num_chunks = 0;
      episode_data.num_removed_chunks = 0;
      episode_data.summary_metadata = "PENDING";
      episode_data.transcript_uri = "PENDING";
      episode_data.number_of_personalities = analysis.number_of_personalities;
      episode_data.topic_match = analysis.topic_match;

      logger.info(`Episode to add to the database: ${JSON.stringify(episode_data)}`);
    
    return episode_data as PodcastEpisodeData;
    
  }
  private async insertUnfoundUrl(podcast_title: string, arg1: string, message: any, arg3: string) {
    throw new Error('Method not implemented.');
  }


  // /**
  //  * Get episode metadata from iTunes with retry mechanism
  //  * 
  //  * @param episode_title - Episode title to search for
  //  * @returns Promise<EpisodeMetadata | null>
  //  */
  // private async itunesEpisodeMetadata(episode_title: string): Promise<EpisodeMetadata | null> {
  //   const maxRetries = 3;
  //   const initialDelay = 5 * 60 * 1000; // 5 minutes

  //   for (let attempt = 0; attempt < maxRetries; attempt++) {
  //     try {
  //       const encoded_title = encodeURIComponent(episode_title);
  //       const search_url = `https://itunes.apple.com/search?term=${encoded_title}&entity=podcastEpisode`;
        
  //       logger.info(`Requesting ${search_url}`);
        
  //       const response = await this.makeHttpRequest(search_url);
        
  //       if (response.status !== 200) {
  //         logger.error(`Request failed. Status code: ${response.status}, Url: ${search_url}`);
  //         return null;
  //       }

  //       try {
  //         const json_data = typeof response.data === 'object' ? response.data : JSON.parse(response.data);
          
  //         if (json_data.results && json_data.results.length > 0) {
  //           for (const episodeInfo of json_data.results) {
  //             if (episode_title.toLowerCase() === episodeInfo.trackName?.trim().toLowerCase()) {
  //               return {
  //                 episode_id: episodeInfo.trackId,
  //                 podcast_id: episodeInfo.collectionId,
  //                 episode_guid: episodeInfo.episodeGuid || "",
  //                 image: {
  //                   artworkUrl600: episodeInfo.artworkUrl600 || "",
  //                   artworkUrl160: episodeInfo.artworkUrl160 || "",
  //                   artworkUrl60: episodeInfo.artworkUrl60 || "",
  //                 },
  //                 genres: (episodeInfo.genres || []).map((genre: any) => genre.name || ""),
  //                 country: episodeInfo.country || "",
  //                 trackTimeMillis: episodeInfo.trackTimeMillis || 0,
  //                 episode_url: episodeInfo.trackViewUrl || ""
  //               };
  //             }
  //           }
  //           logger.info(`Podcast not found, episode title: ${episode_title}`);
  //           return null;
  //         }
  //       } catch (jsonError) {
  //         logger.error(`Failed to parse JSON. Response content: ${response.data}`);
  //         return null;
  //       }
  //     } catch (error: any) {
  //       logger.error(`Error occurred (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);
        
  //       if (attempt < maxRetries - 1) {
  //         const delay = initialDelay * Math.pow(2, attempt);
  //         logger.info(`Retrying in ${delay / 1000} seconds...`);
  //         await sleep(delay);
  //       } else {
  //         throw error;
  //       }
  //     }
  //   }
    
  //   return null;
  // }
  // /**
  //  * Get episode metadata from specified source
  //  * 
  //  * @param episode_title - Episode title to search for
  //  * @param type - Source type (currently only "itunes" supported)
  //  * @returns Promise<EpisodeMetadata | null>
  //  */
  // private async getEpisodeMetadata(episode_title: string, type: string = "itunes"): Promise<EpisodeMetadata | null> {
  //   try {
  //     if (type === "itunes") {
  //       const episode_metadata = await this.itunesEpisodeMetadata(episode_title);
  //       return episode_metadata;
  //     }
  //     return null;
  //   } catch (error: any) {
  //     return null;
  //   }
  // }

  /**
   * Analyze podcast summary using Cohere model with topic keywords
   * 
   * @param summary - Podcast summary
   * @param topic_keywords - Array of topic keywords
   * @param title - Podcast title
   * @returns Promise<ContentAnalysisResult>
   */
  private async analyzePodcastSummaryCohere(
    summary: string, 
    topic_keywords: string[], 
    title: string
  ): Promise<ContentAnalysisResult> {
    const maxRetries = 4;
    
    for (let retries = 0; retries < maxRetries; retries++) {
      try {
        const client = new BedrockRuntimeClient({ region: "us-east-1" });
        const model_id = "cohere.command-r-plus-v1:0";

        const system = `
          You are an AI assistant specializing in analyzing podcast content. 
          Your task is to extract structured information from the provided podcast summary and title. 
          - "number_of_personalities": The total number of guests or personalities mentioned in the podcast who were interviewed by host.
          - "personalities": A list of the names of guests or personalities who were interviewed by host (if any).
          - "topic_match": A boolean indicating whether the any topics discussed match or are similar to any provided topic list. If the topic_keywords is empty then mark it as true.
          - "matching_topics": A list of topics from the provided list that match or are semantically similar or has same meaning to those discussed.
        `;

        const initial_prompt = `
          \n
          Analyze the below podcast information:
          - Podcast Title: <title>${title}</title>
          - Podcast Summary: <summary>${summary}</summary>
          - Provided Topic List: <topic_keywords>${JSON.stringify(topic_keywords)}</topic_keywords>
        `;

        const output_format = `
          \n
          For each podcast, provide your analysis using XML tags with the following below structure:

          <podcast_analysis>
              <personalities_info>
                  <count>[Total number of guests/personalities who were interviewed by host (in integer)]</count>
                  <names>
                      <person>[Name of each guest/personality who were interviewed by host. Create such more for each guest/personality who were interviewed by host]</person>
                  </names>
              </personalities_info>

              <topic_analysis>
                  <matches_provided_topics>[true/false]</matches_provided_topics>
                  <matching_topics>
                      <topic>[Each topic that matches or is semantically similar to provided topics. ]</topic>
                  </matching_topics>
              </topic_analysis>
          </podcast_analysis>

          \n
          Your answer must start with tag <podcast_analysis> and end with tag </podcast_analysis>
          skip preamble;
        `;

        const prompt = system + initial_prompt + output_format;

        const native_request = {
          message: prompt,
          max_tokens: 512,
          temperature: 0.2,
          p: 0.01,
          k: 0
        };

        const command = new InvokeModelCommand({
          modelId: model_id,
          body: JSON.stringify(native_request)
        });

        const response = await client.send(command);
        const response_body = JSON.parse(new TextDecoder().decode(response.body));
        const value = response_body.text;

        // Replace ampersands that are not part of a valid entity
        const formatted_xml_value = value.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;');
        
        const parsedXML = parseXML(formatted_xml_value);
        
        const personalities_count = parseInt(extractXMLElements(parsedXML, 'count')[0] || '0');
        const personalities = extractXMLElements(parsedXML, 'person');

        const topic_match = extractXMLElements(parsedXML, 'matches_provided_topics')[0]?.toLowerCase() === 'true';
        const matching_topics = extractXMLElements(parsedXML, 'topic');

        return {
          number_of_personalities: personalities_count,
          personalities,
          topic_match,
          matching_topics
        };

      } catch (error: any) {
        logger.error(`Error occurred (attempt ${retries + 1}/${maxRetries}): ${error.message}`);
        
        if (error.name === 'ThrottlingException') {
          logger.info("Sleeping for 60 seconds before retrying...");
          await sleep(60000);
        }
        
        if (retries < maxRetries - 1) {
          continue;
        } else {
          throw new Error("Max retries exceeded for Cohere Command R+ model invocation.");
        }
      }
    }
    
    throw new Error("Max retries exceeded for Cohere Command R+ model invocation.");
  }

  /**
   * Analyze podcast summary using Cohere model without specific topic keywords
   * 
   * @param summary - Podcast summary
   * @param title - Podcast title
   * @returns Promise<ContentAnalysisResult>
   */
  private async analyzePodcastSummaryCohereNonTopics(summary: string, title: string): Promise<ContentAnalysisResult> {
    const maxRetries = 4;
    
    for (let retries = 0; retries < maxRetries; retries++) {
      try {
        const client = new BedrockRuntimeClient({ region: "us-east-1" });
        const model_id = "cohere.command-r-plus-v1:0";

        const system = `
          You are an AI assistant specializing in analyzing podcast content. 
          Your task is to extract structured information from the provided podcast summary and title. 
          - "number_of_personalities": The total number of guests or personalities mentioned in the podcast who were interviewed by host.
          - "personalities": A list of the names of guests or personalities who were interviewed by host (if any).
          - "topics": A list of high level 1-2 words topic which will capture the intent of summary and will represent the summary.
        `;

        const initial_prompt = `
          \n
          Analyze the below podcast information:
          - Podcast Title: <title>${title}</title>
          - Podcast Summary: <summary>${summary}</summary>
        `;

        const output_format = `
          \n
          For each podcast, provide your analysis using XML tags with the following below structure:

          <podcast_analysis>
              <personalities_info>
                  <count>[Total number of guests/personalities who were interviewed by host (in integer)]</count>
                  <names>
                      <person>[Name of each guest/personality who were interviewed by host. Create such more for each guest/personality who were interviewed by host]</person>
                  </names>
              </personalities_info>

              <topic_analysis>
                  <matches_provided_topics>[true/false]</matches_provided_topics>
                  <matching_topics>
                      <topic>[Each topic that matches or is semantically similar to provided topics. ]</topic>
                  </matching_topics>
              </topic_analysis>
          </podcast_analysis>

          \n
          Your answer must start with tag <podcast_analysis> and end with tag </podcast_analysis>
          skip preamble;
        `;

        const prompt = system + initial_prompt + output_format;

        const native_request = {
          message: prompt,
          max_tokens: 400,
          temperature: 0.2,
          p: 0.1,
          k: 0
        };

        const command = new InvokeModelCommand({
          modelId: model_id,
          body: JSON.stringify(native_request)
        });

        const response = await client.send(command);
        const response_body = JSON.parse(new TextDecoder().decode(response.body));
        const value = response_body.text;

        // Replace ampersands that are not part of a valid entity
        const formatted_xml_value = value.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;');
        
        const parsedXML = parseXML(formatted_xml_value);
        
        const personalities_count = parseInt(extractXMLElements(parsedXML, 'count')[0] || '0');
        const personalities = extractXMLElements(parsedXML, 'person');

        const matching_topics = extractXMLElements(parsedXML, 'topic');

        return {
          number_of_personalities: personalities_count,
          personalities,
          topic_match: true,
          matching_topics
        };

      } catch (error: any) {
        logger.error(`Error occurred (attempt ${retries + 1}/${maxRetries}): ${error.message}`);
        
        if (error.name === 'ThrottlingException') {
          logger.info("Sleeping for 60 seconds before retrying...");
          await sleep(60000);
        }
        
        if (retries < maxRetries - 1) {
          continue;
        } else {
          throw new Error("Max retries exceeded for Cohere Command R+ model invocation.");
        }
      }
    }
    
    throw new Error("Max retries exceeded for Cohere Command R+ model invocation.");
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
      // Handle timestamp
      date = new Date(published);
    } else if (typeof published === 'string') {
      // Check if it's a valid date string
      if (published.trim() === '') {
        return undefined;
      }
      
      // Try parsing the string
      date = new Date(published);
    } else {
      return undefined;
    }
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      return undefined;
    }
    
    // Return ISO string format
    return date.toISOString();
  } catch (error) {
    logger.error(`Failed to parse date: ${published}`, error as Error);
    return undefined;
  }
}


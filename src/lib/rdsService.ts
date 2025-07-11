import { Client } from 'pg';
import { VideoMetadata, RDSEpisodeData, EpisodeProcessingInfo } from '../types.js';
import { logger } from './logger.js';
import { GuestExtractionService, GuestExtractionResult } from './guestExtractionService.js';
import { parsePostgresArray } from './utils/utils.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface RDSConfig {
  host: string;
  user: string;
  password: string;
  database: string;
  port: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface SQSMessageBody {
  videoId: string;
  episodeTitle: string;
  channelName: string;
  channelId: string;
  originalUri: string;
  publishedDate: string;
  contentType: 'Video';
  hostName: string;
  hostDescription: string;
  languageCode?: string;
  genre: string;
  country: string;
  websiteLink: string;
  additionalData: {
    youtubeVideoId: string;
    youtubeChannelId: string;
    youtubeUrl: string;
    notificationReceived: string;
    [key: string]: any;
  };
}

export interface EpisodeRecord {
  // Database fields matching the actual Episode table schema
  episodeId: string;
  episodeTitle: string;
  episodeDescription: string;
  episodeThumbnailImageUrl?: string; // S3 URL for episode thumbnail
  episodeUrl?: string; // S3 URL for episode audio/video file
  originalUrl: string; // Original source site URL
  durationMillis?: number;
  publishedDate: string; // ISO date string
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
  deletedAt?: string | null; // ISO date string, null when not deleted
  
  channelId: string;
  channelName: string;
  rssUrl?: string;
  channelThumbnailUrl?: string; // S3 URL for channel thumbnail
  
  hostName?: string;
  hostDescription?: string;
  hostImageUrl?: string; // S3 URL for host image
  
  guests?: string[]; // JSON array of guest names
  guestDescriptions?: string[]; // JSON array of guest descriptions
  guestImages?: string[]; // JSON array of S3 URLs for guest images
  
  topics?: string[]; // JSON array of topics/tags
  summaryMetadata?: Record<string, any>; // JSON for summary metadata
  
  country?: string;
  genre?: string;
  languageCode?: string;
  
  transcriptUri?: string; // S3 URL
  processedTranscriptUri?: string; // S3 URL
  summaryAudioUri?: string; // S3 URL
  summaryDurationMillis?: number;
  summaryTranscriptUri?: string; // S3 URL
  
  contentType: 'Audio' | 'Video';
  processingInfo: EpisodeProcessingInfo; // JSON
  additionalData: Record<string, any>; // JSON for future purposes
  processingDone: boolean;
  isSynced: boolean;
  
  // Legacy fields for backward compatibility (can be removed later)
  pk?: string; // Primary key: EPISODE#{episodeId}
  sk?: string; // Sort key: METADATA
  originalUri?: string; // Alias for originalUrl
  episodeUri?: string; // Alias for episodeUrl
}

/**
 * PostgreSQL-based RDS Service for managing podcast episode data
 * This is a simplified version focusing on core functionality
 */
export class RDSService {
  private config: RDSConfig;
  private guestExtractionService?: GuestExtractionService;

  constructor(config: RDSConfig, guestExtractionService?: GuestExtractionService) {
    this.config = config;
    this.guestExtractionService = guestExtractionService;
  }

  /**
   * Create a new database client connection
   */
  private async createClient(): Promise<Client> {
    const connectionConfig = {
      host: this.config.host,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      port: this.config.port,
      ssl: this.config.ssl,
    };

    // Try SSL connection first, fallback to non-SSL if it fails
    let client = new Client(connectionConfig);
    
    try {
      await client.connect();
      logger.info('Connected to RDS with SSL');
      return client;
    } catch (sslError: any) {
      logger.warn('SSL connection failed, attempting non-SSL connection:', sslError.message);
      
      // Close the failed client
      try {
        await client.end();
      } catch (e) {
        // Ignore cleanup errors
      }
      
      // Try without SSL
      const nonSslConfig = {
        ...connectionConfig,
        ssl: false,
      };
      
      client = new Client(nonSslConfig);
      await client.connect();
      logger.info('Connected to RDS without SSL');
      return client;
    }
  }

  /**
   * Store new episode data from SQS message
   */
  async storeNewEpisode(
    channelId: string,
    messageBody: SQSMessageBody,
    metadata?: VideoMetadata,
    episodePK?: string,
    episodeSK?: string,
    enrichGuests: boolean = true,
    enrichTopics: boolean = true
  ): Promise<{ episodePK: string; episodeSK: string }> {
    const client = await this.createClient();
    
    try {
      // Generate episode ID if not provided
      const episodeId = episodePK ? episodePK.replace('EPISODE#', '') : this.generateEpisodeId();
      const pk = episodePK || `EPISODE#${episodeId}`;
      const sk = episodeSK || 'METADATA';
      
      // Prepare episode data matching the actual database schema
      const episodeData: Partial<EpisodeRecord> = {
        episodeId,
        episodeTitle: messageBody.episodeTitle,
        episodeDescription: metadata?.description || '',
        hostName: messageBody.hostName,
        hostDescription: messageBody.hostDescription,
        channelName: messageBody.channelName,
        channelId: messageBody.channelId,
        originalUrl: messageBody.originalUri,
        publishedDate: messageBody.publishedDate,
        episodeUrl: undefined, // Will be set when video/audio is processed
        country: messageBody.country,
        genre: messageBody.genre,
        durationMillis: metadata?.duration ? metadata.duration * 1000 : 0,
        rssUrl: undefined, // Can be set later
        contentType: messageBody.contentType || 'Video',
        processingDone: false,
        isSynced: false,
        processingInfo: {
          episodeTranscribingDone: false,
          summaryTranscribingDone: false,
          summarizingDone: false,
          numChunks: 0,
          numRemovedChunks: 0,
          chunkingDone: false,
          quotingDone: false,
        },
        additionalData: messageBody.additionalData || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        
        // Legacy compatibility
        pk,
        sk,
        originalUri: messageBody.originalUri, // Alias
      };

      // Insert into database using correct column names
      const query = `
        INSERT INTO episodes (
          episode_id, episode_title, episode_description, episode_thumbnail_image_url,
          episode_url, original_url, duration_millis, published_date, created_at, updated_at, deleted_at,
          channel_id, channel_name, rss_url, channel_thumbnail_url,
          host_name, host_description, host_image_url,
          guests, guest_descriptions, guest_images,
          topics, summary_metadata,
          country, genre, language_code,
          transcript_uri, processed_transcript_uri, summary_audio_uri, summary_duration_millis, summary_transcript_uri,
          content_type, processing_info, additional_data, processing_done, is_synced
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
        )
        ON CONFLICT (episode_id) DO UPDATE SET
          episode_title = EXCLUDED.episode_title,
          episode_description = EXCLUDED.episode_description,
          updated_at = EXCLUDED.updated_at
      `;
      
      const values = [
        episodeData.episodeId,                              // $1
        episodeData.episodeTitle,                           // $2
        episodeData.episodeDescription,                     // $3
        null,                                               // $4 - episode_thumbnail_image_url
        episodeData.episodeUrl,                             // $5
        episodeData.originalUrl,                            // $6
        episodeData.durationMillis,                         // $7
        episodeData.publishedDate,                          // $8
        episodeData.createdAt,                              // $9
        episodeData.updatedAt,                              // $10
        episodeData.deletedAt,                              // $11
        episodeData.channelId,                              // $12
        episodeData.channelName,                            // $13
        episodeData.rssUrl,                                 // $14
        null,                                               // $15 - channel_thumbnail_url
        episodeData.hostName,                               // $16
        episodeData.hostDescription,                        // $17
        null,                                               // $18 - host_image_url
        null,                                               // $19 - guests (JSON)
        null,                                               // $20 - guest_descriptions (JSON)
        null,                                               // $21 - guest_images (JSON)
        null,                                               // $22 - topics (JSON)
        null,                                               // $23 - summary_metadata (JSON)
        episodeData.country,                                // $24
        episodeData.genre,                                  // $25
        null,                                               // $26 - language_code
        null,                                               // $27 - transcript_uri
        null,                                               // $28 - processed_transcript_uri
        null,                                               // $29 - summary_audio_uri
        null,                                               // $30 - summary_duration_millis
        null,                                               // $31 - summary_transcript_uri
        episodeData.contentType,                            // $32
        JSON.stringify(episodeData.processingInfo),         // $33
        JSON.stringify(episodeData.additionalData),         // $34
        episodeData.processingDone,                         // $35
        episodeData.isSynced,                               // $36
      ];
      
      await client.query(query, values);
      
      logger.info(`Episode stored successfully: ${pk}/${sk}`);

      return { episodePK: pk, episodeSK: sk };
    } catch (error) {
      logger.error(`Failed to store episode:`, error as Error);
      throw error;
    } finally {
      await client.end();
    }
  }

  /**
   * Get episode by ID
   */
  async getEpisode(episodeId: string): Promise<EpisodeRecord | null> {
    const client = await this.createClient();
    
    try {
      logger.info(`Fetching episode: ${episodeId}`);
      
      const query = `
        SELECT 
          episode_id, episode_title, episode_description, episode_thumbnail_image_url,
          episode_url, original_url, duration_millis, published_date, created_at, updated_at, deleted_at,
          channel_id, channel_name, rss_url, channel_thumbnail_url,
          host_name, host_description, host_image_url,
          guests, guest_descriptions, guest_images,
          topics, summary_metadata,
          country, genre, language_code,
          transcript_uri, processed_transcript_uri, summary_audio_uri, summary_duration_millis, summary_transcript_uri,
          content_type, processing_info, additional_data, processing_done, is_synced
        FROM episodes 
        WHERE episode_id = $1
      `;
      
      const result = await client.query(query, [episodeId]);
      
      if (result.rows.length === 0) {
        logger.info(`Episode not found: ${episodeId}`);
        return null;
      }
      
      const row = result.rows[0];
      
      // Parse JSON fields safely
      const processingInfo = row.processing_info ? JSON.parse(row.processing_info) : {
        episodeTranscribingDone: false,
        summaryTranscribingDone: false,
        summarizingDone: false,
        numChunks: 0,
        numRemovedChunks: 0,
        chunkingDone: false,
        quotingDone: false
      };
      const guests = row.guests ? JSON.parse(row.guests) : [];
      const guestDescriptions = row.guest_descriptions ? JSON.parse(row.guest_descriptions) : [];
      const guestImages = row.guest_images ? JSON.parse(row.guest_images) : [];
      const topics = row.topics ? JSON.parse(row.topics) : [];
      const summaryMetadata = row.summary_metadata ? JSON.parse(row.summary_metadata) : {};
      const additionalData = row.additional_data ? JSON.parse(row.additional_data) : {};
      
      const episode: EpisodeRecord = {
        episodeId: row.episode_id,
        episodeTitle: row.episode_title,
        episodeDescription: row.episode_description,
        episodeThumbnailImageUrl: row.episode_thumbnail_image_url,
        episodeUrl: row.episode_url,
        originalUrl: row.original_url,
        durationMillis: row.duration_millis,
        publishedDate: row.published_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        
        channelId: row.channel_id,
        channelName: row.channel_name,
        rssUrl: row.rss_url,
        channelThumbnailUrl: row.channel_thumbnail_url,
        
        hostName: row.host_name,
        hostDescription: row.host_description,
        hostImageUrl: row.host_image_url,
        
        guests: guests,
        guestDescriptions: guestDescriptions,
        guestImages: guestImages,
        
        topics: topics,
        summaryMetadata: summaryMetadata,
        
        country: row.country,
        genre: row.genre,
        languageCode: row.language_code,
        
        transcriptUri: row.transcript_uri,
        processedTranscriptUri: row.processed_transcript_uri,
        summaryAudioUri: row.summary_audio_uri,
        summaryDurationMillis: row.summary_duration_millis,
        summaryTranscriptUri: row.summary_transcript_uri,
        
        contentType: row.content_type,
        processingInfo: processingInfo,
        additionalData: additionalData,
        processingDone: row.processing_done,
        isSynced: row.is_synced,
        
        // Legacy fields for backward compatibility
        originalUri: row.original_url, // Alias
        episodeUri: row.episode_url    // Alias
      };
      
      logger.info(`Episode fetched successfully: ${episodeId}`);
      return episode;
      
    } catch (error) {
      logger.error(`Failed to fetch episode ${episodeId}:`, error as Error);
      throw error;
    } finally {
      await client.end();
    }
  }

  /**
   * Update episode data
   */
  async updateEpisode(episodeId: string, updateData: Partial<EpisodeRecord>): Promise<void> {
    const client = await this.createClient();
    
    try {
      logger.info(`Updating episode: ${episodeId}`);
      
      // Build SQL update query dynamically based on provided data
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      
      // Handle basic fields
      if (updateData.episodeTitle !== undefined) {
        updateFields.push(`episode_title = $${paramIndex++}`);
        values.push(updateData.episodeTitle);
      }
      
      if (updateData.episodeDescription !== undefined) {
        updateFields.push(`episode_description = $${paramIndex++}`);
        values.push(updateData.episodeDescription);
      }
      
      if (updateData.hostName !== undefined) {
        updateFields.push(`host_name = $${paramIndex++}`);
        values.push(updateData.hostName);
      }
      
      if (updateData.hostDescription !== undefined) {
        updateFields.push(`host_description = $${paramIndex++}`);
        values.push(updateData.hostDescription);
      }
      
      if (updateData.episodeUrl !== undefined) {
        updateFields.push(`episode_url = $${paramIndex++}`);
        values.push(updateData.episodeUrl);
      }
      
      if (updateData.originalUrl !== undefined) {
        updateFields.push(`original_url = $${paramIndex++}`);
        values.push(updateData.originalUrl);
      }
      
      if (updateData.contentType !== undefined) {
        updateFields.push(`content_type = $${paramIndex++}`);
        values.push(updateData.contentType);
      }
      
      if (updateData.country !== undefined) {
        updateFields.push(`country = $${paramIndex++}`);
        values.push(updateData.country);
      }
      
      if (updateData.genre !== undefined) {
        updateFields.push(`genre = $${paramIndex++}`);
        values.push(updateData.genre);
      }
      
      if (updateData.durationMillis !== undefined) {
        updateFields.push(`duration_millis = $${paramIndex++}`);
        values.push(updateData.durationMillis);
      }
      
      if (updateData.rssUrl !== undefined) {
        updateFields.push(`rss_url = $${paramIndex++}`);
        values.push(updateData.rssUrl);
      }
      
      if (updateData.processingDone !== undefined) {
        updateFields.push(`processing_done = $${paramIndex++}`);
        values.push(updateData.processingDone);
      }
      
      if (updateData.isSynced !== undefined) {
        updateFields.push(`is_synced = $${paramIndex++}`);
        values.push(updateData.isSynced);
      }
      
      // Handle guest-related fields
      if (updateData.guests !== undefined) {
        updateFields.push(`guests = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guests));
      }
      
      if (updateData.guestDescriptions !== undefined) {
        updateFields.push(`guest_descriptions = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guestDescriptions));
      }
      
      if (updateData.guestImages !== undefined) {
        updateFields.push(`guest_images = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guestImages));
      }
      
      if (updateData.topics !== undefined) {
        updateFields.push(`topics = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.topics));
      }
      
      if (updateData.summaryMetadata !== undefined) {
        updateFields.push(`summary_metadata = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.summaryMetadata));
      }
      
      // Handle transcript and summary fields
      if (updateData.transcriptUri !== undefined) {
        updateFields.push(`transcript_uri = $${paramIndex++}`);
        values.push(updateData.transcriptUri);
      }
      
      if (updateData.processedTranscriptUri !== undefined) {
        updateFields.push(`processed_transcript_uri = $${paramIndex++}`);
        values.push(updateData.processedTranscriptUri);
      }
      
      if (updateData.summaryAudioUri !== undefined) {
        updateFields.push(`summary_audio_uri = $${paramIndex++}`);
        values.push(updateData.summaryAudioUri);
      }
      
      if (updateData.summaryDurationMillis !== undefined) {
        updateFields.push(`summary_duration_millis = $${paramIndex++}`);
        values.push(updateData.summaryDurationMillis);
      }
      
      if (updateData.summaryTranscriptUri !== undefined) {
        updateFields.push(`summary_transcript_uri = $${paramIndex++}`);
        values.push(updateData.summaryTranscriptUri);
      }
      
      // Handle processing info
      if (updateData.processingInfo !== undefined) {
        updateFields.push(`processing_info = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.processingInfo));
      }
      
      // Handle additional data (merge with existing)
      if (updateData.additionalData !== undefined) {
        updateFields.push(`additional_data = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.additionalData));
      }
      
      // Handle soft delete
      if (updateData.deletedAt !== undefined) {
        updateFields.push(`deleted_at = $${paramIndex++}`);
        values.push(updateData.deletedAt);
      }
      
      // Always update the updated_at timestamp
      updateFields.push(`updated_at = $${paramIndex++}`);
      values.push(new Date().toISOString());
      
      if (updateFields.length === 1) {
        // Only updated_at field, no actual changes
        logger.info(`No fields to update for episode: ${episodeId}`);
        return;
      }
      
      // Add episodeId as the last parameter for WHERE clause
      values.push(episodeId);
      
      const query = `
        UPDATE episodes 
        SET ${updateFields.join(', ')}
        WHERE episode_id = $${paramIndex}
      `;
      
      const result = await client.query(query, values);
      
      if (result.rowCount === 0) {
        logger.warn(`No episode found with ID: ${episodeId}`);
      } else {
        logger.info(`Episode updated successfully: ${episodeId}`);
      }
      
    } catch (error) {
      logger.error(`Failed to update episode ${episodeId}:`, error as Error);
      throw error;
    } finally {
      await client.end();
    }
  }

  /**
   * Update episode with guest extraction results
   */
  async updateEpisodeWithGuestExtraction(episodeId: string, extractionResult: GuestExtractionResult): Promise<void> {
    try {
      logger.info(`Updating episode ${episodeId} with guest extraction results`);
      
      // Prepare guest data for RDS
      const guestNames = extractionResult.guest_names;
      const guestDescriptions = guestNames.map(name => {
        const guestDetail = extractionResult.guest_details[name];
        return guestDetail?.description || 'No description available';
      });

      // Prepare guest images data
      const guestImages = guestNames.map(name => {
        const guestDetail = extractionResult.guest_details[name];
        if (guestDetail?.image?.s3Url) {
          return guestDetail.image.s3Url;
        }
        return null;
      }).filter(Boolean);

      // Prepare enrichment metadata
      const enrichmentMetadata = {
        extractionDate: new Date().toISOString(),
        totalGuests: guestNames.length,
        successfulEnrichments: Object.keys(extractionResult.guest_details).length,
        confidenceBreakdown: this.calculateConfidenceBreakdown(extractionResult.guest_details),
        topicsExtracted: extractionResult.topics.length,
        hasGuestImages: guestImages.length > 0,
        guestImageCount: guestImages.length
      };

      // Get existing additional data to merge
      const existingEpisode = await this.getEpisode(episodeId);
      const existingAdditionalData = existingEpisode?.additionalData || {};

      // Update episode with extraction results using the new schema
      const updateData = {
        guests: guestNames,
        guestDescriptions: guestDescriptions,
        guestImages: guestImages, // Store guest images in dedicated field
        topics: extractionResult.topics,
        additionalData: {
          ...existingAdditionalData,
          guestEnrichmentMetadata: enrichmentMetadata,
          extractedDescription: extractionResult.description
        }
      };

      await this.updateEpisode(episodeId, updateData);
      
      logger.info(`Updated episode ${episodeId} with ${guestNames.length} guests, ${extractionResult.topics.length} topics, and ${guestImages.length} guest images`);
      
    } catch (error) {
      logger.error(`Failed to update episode ${episodeId} with guest extraction results:`, error as Error);
      throw error;
    }
  }

  /**
   * Calculate confidence breakdown for enrichment metadata
   */
  private calculateConfidenceBreakdown(guestDetails: Record<string, any>): { high: number; medium: number; low: number } {
    const breakdown = { high: 0, medium: 0, low: 0 };
    
    Object.values(guestDetails).forEach((detail: any) => {
      if (detail.confidence) {
        breakdown[detail.confidence as keyof typeof breakdown]++;
      }
    });
    
    return breakdown;
  }

  /**
   * Enrich guest information (stub implementation)
   */
  async enrichGuestInfo(episodeId: string): Promise<EpisodeRecord | null> {
    if (this.guestExtractionService) {
      logger.info(`Starting guest enrichment for episode: ${episodeId}`);
      
      try {
        // Get existing episode data
        const episode = await this.getEpisode(episodeId);
        if (!episode) {
          logger.warn(`Episode ${episodeId} not found for guest enrichment`);
          return null;
        }

        // Use guest extraction service to enrich
        const result = await this.guestExtractionService.extractAndUpdateEpisode(episodeId, {
          podcast_title: episode.channelName,
          episode_title: episode.episodeTitle,
          episode_description: episode.episodeDescription || ''
        });

        if (result) {
          logger.info(`Successfully enriched episode ${episodeId} with ${result.guest_names.length} guests and ${result.topics.length} topics`);
          return await this.getEpisode(episodeId); // Return updated episode
        }
        
      } catch (error) {
        logger.error(`Guest enrichment failed for episode ${episodeId}:`, error as Error);
      }
    } else {
      logger.info(`Guest enrichment not available for episode: ${episodeId}`);
    }
    
    return await this.getEpisode(episodeId);
  }

  /**
   * Enrich topic information (stub implementation)  
   */
  async enrichTopicInfo(episodeId: string): Promise<EpisodeRecord | null> {
    if (this.guestExtractionService) {
      logger.info(`Topic enrichment available via guest extraction for episode: ${episodeId}`);
      // Topics are already extracted as part of guest enrichment
      return await this.getEpisode(episodeId);
    } else {
      logger.info(`Topic enrichment not available for episode: ${episodeId}`);
      return await this.getEpisode(episodeId);
    }
  }

  /**
   * Generate a unique episode ID
   */
  private generateEpisodeId(): string {
    return `episode_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Note: Guest enrichment methods are commented out in the original file
  // They can be re-implemented using the new GuestExtractionService when needed
}

/**
 * Create RDS service instance from environment variables
 */
export function createRDSService(): RDSService {
  const config: RDSConfig = {
    host: process.env.RDS_HOST || 'localhost',
    user: process.env.RDS_USER || 'postgres',
    password: process.env.RDS_PASSWORD || '',
    database: process.env.RDS_DATABASE || 'postgres',
    port: parseInt(process.env.RDS_PORT || '5432'),
    ssl: { rejectUnauthorized: false }, // Force SSL encryption for all RDS connections
  };

  return new RDSService(config);
}

/**
 * Create RDS service instance from environment variables
 */
export function createRDSServiceFromEnv(): RDSService | null {
  if (!process.env.RDS_HOST || !process.env.RDS_USER || !process.env.RDS_PASSWORD) {
    return null;
  }

  const config: RDSConfig = {
    host: process.env.RDS_HOST,
    user: process.env.RDS_USER,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DATABASE || 'postgres',
    port: parseInt(process.env.RDS_PORT || '5432'),
    ssl: { rejectUnauthorized: false }, // Always require SSL for RDS connections
  };

  return new RDSService(config);
}

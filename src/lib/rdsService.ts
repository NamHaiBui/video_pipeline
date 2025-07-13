import { Client } from 'pg';
import { VideoMetadata, RDSEpisodeData, EpisodeProcessingInfo } from '../types.js';
import { logger } from './utils/logger.js';
import { GuestExtractionService, GuestExtractionResult } from './guestExtractionService.js';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

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
  episodeImages?: string[]; // S3 URLs for episode images
}
export interface GuestRecord {
  guestId?: string; 
  guestName: string;
  guestDescription: string;
  guestImage: string;
  guestLanguage: string;
}

/**
 * PostgreSQL-based RDS Service for managing podcast episode data
 * This is a simplified version focusing on core functionality
 */
export class RDSService {
  
  
  private config: RDSConfig;
  private guestExtractionService?: GuestExtractionService;
  private client: Client | null = null;

  constructor(config: RDSConfig, guestExtractionService?: GuestExtractionService) {
    this.config = config;
    this.guestExtractionService = guestExtractionService;
  }

  /**
   * Initialize the global RDS client connection (call this on server startup)
   */
  async initClient(): Promise<void> {
    if (this.client) return; 
    const connectionConfig = {
      host: this.config.host,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      port: this.config.port,
      ssl: this.config.ssl,
    };
    this.client = new Client(connectionConfig);
    await this.client.connect();
    logger.info('Global RDS client connected with SSL');
  }

  /**
   * Use the global client for all queries
   */
  private getClient(): Client {
    if (!this.client) throw new Error('RDS client not initialized. Call initClient() on startup.');
    return this.client;
  }
  /**
   * Gracefully close the global RDS client connection (call on server shutdown)
   */
  async closeClient(): Promise<void> {
    if (this.client) {
      try {
        await this.client.end();
        logger.info('Global RDS client connection closed');
      } catch (error) {
        logger.error('Error closing RDS client:', error as Error);
      }
      this.client = null;
    }
  }
  /**
   * Get guest by name from the database
   */
  async getGuestByName(guestName: string): Promise<GuestRecord | null> {
    const client = this.getClient();
    try {
      const query = `
        SELECT 
          "guestName", "guestDescription", "guestImage", "guestLanguage"
        FROM public."Guests"
        WHERE "guestName" = $1
      `;
      const result = await client.query(query, [guestName]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        guestId: row.guestId,
        guestName: row.guestName,
        guestDescription: row.guestDescription,
        guestImage: row.guestImage,
        guestLanguage: row.guestLanguage || 'en',
      };
    } catch (error) {
      logger.error('Error fetching guest by name:', error as Error);
      return null;
    }
  }
  
  /**
   * Store new episode data from SQS message
   */
  async storeNewEpisode(
    messageBody: SQSMessageBody,
    metadata?: VideoMetadata,
    thumbnailUrl?: string
  ): Promise<{ episodeId: string }> {
    
    const client = this.getClient();
    
    try {
      // Generate episode ID if not provided
      const episodeId = uuidv4();
      
      // Prepare episode data matching the actual database schema
      const episodeData: Partial<EpisodeRecord> = {
        episodeId,
        episodeTitle: messageBody.episodeTitle,
        episodeDescription: sanitizeDescription(metadata?.description || ''),
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
        rssUrl: undefined, 
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
        episodeImages: [], // Set to empty array or populate as needed
      };

      // Insert into database using correct column names (updated schema)
      const query = `
        INSERT INTO public."Episodes" (
          "episodeId", "episodeTitle", "episodeDescription",
          "hostName", "hostDescription", "channelName",
          "guests", "guestDescriptions", "guestImageUrl",
          "publishedDate", "episodeUri", "originalUri",
          "channelId", "country", "genre", "episodeImages",
          "durationMillis", "rssUrl", "transcriptUri", "processedTranscriptUri",
          "summaryAudioUri", "summaryDurationMillis", "summaryTranscriptUri",
          "topics", "updatedAt", "deletedAt", "createdAt",
          "processingInfo", "contentType", "additionalData", "processingDone", "isSynced"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32
        )
        ON CONFLICT ("episodeId") DO NOTHING
      `;
      
      const values = [
        episodeData.episodeId,                              // $1
        episodeData.episodeTitle,                           // $2
        episodeData.episodeDescription,                     // $3
        episodeData.hostName,                               // $4
        episodeData.hostDescription,                        // $5
        episodeData.channelName,                            // $6
        episodeData.guests || [],                           // $7 (text[])
        episodeData.guestDescriptions || [],                // $8 (text[])
        episodeData.guestImages || [],                      // $9 (text[])
        episodeData.publishedDate ? new Date(episodeData.publishedDate) : null, // $10 (timestamp)
        episodeData.episodeUrl,                             // $11 (episodeUri)
        episodeData.originalUrl,                            // $12 (originalUri)
        episodeData.channelId,                              // $13
        episodeData.country,                                // $14
        episodeData.genre,                                  // $15
        episodeData.episodeImages || [],                    // $16 (text[])
        episodeData.durationMillis,                         // $17
        episodeData.rssUrl,                                 // $18
        episodeData.transcriptUri,                          // $19
        episodeData.processedTranscriptUri,                 // $20
        episodeData.summaryAudioUri,                        // $21
        episodeData.summaryDurationMillis,                  // $22
        episodeData.summaryTranscriptUri,                   // $23
        episodeData.topics || [],                           // $24 (text[])
        new Date().toISOString(),                           // $25 (updatedAt)
        episodeData.deletedAt,                              // $26
        new Date().toISOString(),                           // $27 (createdAt)
        JSON.stringify(episodeData.processingInfo),         // $28 (jsonb)
        episodeData.contentType,                            // $29
        JSON.stringify(episodeData.additionalData),         // $30 (jsonb)
        episodeData.processingDone,                         // $31
        episodeData.isSynced                                // $32
      ];
      
      await client.query(query, values);
      
      logger.info(`Episode stored successfully: ${episodeId}`);

      return { episodeId };
    } catch (error) {
      logger.error(`Failed to store episode:`, error as Error);
      throw error;
    }
  }

  /**
   * Get episode by ID
   */
  async getEpisode(episodeId: string): Promise<EpisodeRecord | null> {
    const client = this.getClient();
    
    try {
      logger.info(`Fetching episode: ${episodeId}`);
      
      const query = `
        SELECT 
          "episodeId", "episodeTitle", "episodeDescription", "episodeThumbnailImageUrl",
          "episodeUrl", "originalUrl", "durationMillis", "publishedDate", "createdAt", "updatedAt", "deletedAt",
          "channelId", "channelName", "rssUrl", "channelThumbnailUrl",
          "hostName", "hostDescription", "hostImageUrl",
          "guests", "guestDescriptions", "guestImages",
          "topics", "summaryMetadata",
          "country", "genre", "languageCode",
          "transcriptUri", "processedTranscriptUri", "summaryAudioUri", "summaryDurationMillis", "summaryTranscriptUri",
          "contentType", "processingInfo", "additionalData", "processingDone", "isSynced"
        FROM public."Episodes" 
        WHERE "episodeId" = $1
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
        episodeId: row.episodeId,
        episodeTitle: row.episodeTitle,
        episodeDescription: row.episodeDescription,
        episodeThumbnailImageUrl: row.episodeThumbnailImageUrl,
        episodeUrl: row.episodeUrl,
        originalUrl: row.originalUrl,
        durationMillis: row.durationMillis,
        publishedDate: row.publishedDate,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        channelId: row.channelId,
        channelName: row.channelName,
        rssUrl: row.rssUrl,
        channelThumbnailUrl: row.channelThumbnailUrl,
        hostName: row.hostName,
        hostDescription: row.hostDescription,
        hostImageUrl: row.hostImageUrl,
        guests: guests,
        guestDescriptions: guestDescriptions,
        guestImages: guestImages,
        topics: topics,
        summaryMetadata: summaryMetadata,
        country: row.country,
        genre: row.genre,
        languageCode: row.languageCode,
        transcriptUri: row.transcriptUri,
        processedTranscriptUri: row.processedTranscriptUri,
        summaryAudioUri: row.summaryAudioUri,
        summaryDurationMillis: row.summaryDurationMillis,
        summaryTranscriptUri: row.summaryTranscriptUri,
        contentType: row.contentType,
        processingInfo: processingInfo,
        additionalData: additionalData,
        processingDone: row.processingDone,
        isSynced: row.isSynced,
        // Legacy fields for backward compatibility
        originalUri: row.originalUrl, // Alias
        episodeUri: row.episodeUrl    // Alias
      };
      
      logger.info(`Episode fetched successfully: ${episodeId}`);
      return episode;
      
    } catch (error) {
      logger.error(`Failed to fetch episode ${episodeId}:`, error as Error);
      throw error;
    }
  }

  /**
   * Update episode data
   */
  async updateEpisode(episodeId: string, updateData: Partial<EpisodeRecord>): Promise<void> {
    const client = this.getClient();
    
    try {
      logger.info(`Updating episode: ${episodeId}`);
      
      // Build SQL update query dynamically based on provided data
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      //O(1) Run time
      // Handle basic fields
      if (updateData.episodeTitle !== undefined) {
        updateFields.push(`"episodeTitle" = $${paramIndex++}`);
        values.push(updateData.episodeTitle);
      }
      if (updateData.episodeDescription !== undefined) {
        updateFields.push(`"episodeDescription" = $${paramIndex++}`);
        values.push(updateData.episodeDescription);
      }
      if (updateData.hostName !== undefined) {
        updateFields.push(`"hostName" = $${paramIndex++}`);
        values.push(updateData.hostName);
      }
      if (updateData.hostDescription !== undefined) {
        updateFields.push(`"hostDescription" = $${paramIndex++}`);
        values.push(updateData.hostDescription);
      }
      if (updateData.episodeUrl !== undefined) {
        updateFields.push(`"episodeUrl" = $${paramIndex++}`);
        values.push(updateData.episodeUrl);
      }
      if (updateData.originalUrl !== undefined) {
        updateFields.push(`"originalUrl" = $${paramIndex++}`);
        values.push(updateData.originalUrl);
      }
      if (updateData.contentType !== undefined) {
        updateFields.push(`"contentType" = $${paramIndex++}`);
        values.push(updateData.contentType);
      }
      if (updateData.country !== undefined) {
        updateFields.push(`"country" = $${paramIndex++}`);
        values.push(updateData.country);
      }
      if (updateData.genre !== undefined) {
        updateFields.push(`"genre" = $${paramIndex++}`);
        values.push(updateData.genre);
      }
      if (updateData.durationMillis !== undefined) {
        updateFields.push(`"durationMillis" = $${paramIndex++}`);
        values.push(updateData.durationMillis);
      }
      if (updateData.rssUrl !== undefined) {
        updateFields.push(`"rssUrl" = $${paramIndex++}`);
        values.push(updateData.rssUrl);
      }
      if (updateData.processingDone !== undefined) {
        updateFields.push(`"processingDone" = $${paramIndex++}`);
        values.push(updateData.processingDone);
      }
      if (updateData.isSynced !== undefined) {
        updateFields.push(`"isSynced" = $${paramIndex++}`);
        values.push(updateData.isSynced);
      }
      // Handle guest-related fields
      if (updateData.guests !== undefined) {
        updateFields.push(`"guests" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guests));
      }
      if (updateData.guestDescriptions !== undefined) {
        updateFields.push(`"guestDescriptions" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guestDescriptions));
      }
      if (updateData.guestImages !== undefined) {
        updateFields.push(`"guestImages" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guestImages));
      }
      if (updateData.topics !== undefined) {
        updateFields.push(`"topics" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.topics));
      }
      if (updateData.summaryMetadata !== undefined) {
        updateFields.push(`"summaryMetadata" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.summaryMetadata));
      }
      // Handle transcript and summary fields
      if (updateData.transcriptUri !== undefined) {
        updateFields.push(`"transcriptUri" = $${paramIndex++}`);
        values.push(updateData.transcriptUri);
      }
      if (updateData.processedTranscriptUri !== undefined) {
        updateFields.push(`"processedTranscriptUri" = $${paramIndex++}`);
        values.push(updateData.processedTranscriptUri);
      }
      if (updateData.summaryAudioUri !== undefined) {
        updateFields.push(`"summaryAudioUri" = $${paramIndex++}`);
        values.push(updateData.summaryAudioUri);
      }
      if (updateData.summaryDurationMillis !== undefined) {
        updateFields.push(`"summaryDurationMillis" = $${paramIndex++}`);
        values.push(updateData.summaryDurationMillis);
      }
      if (updateData.summaryTranscriptUri !== undefined) {
        updateFields.push(`"summaryTranscriptUri" = $${paramIndex++}`);
        values.push(updateData.summaryTranscriptUri);
      }
      // Handle processing info
      if (updateData.processingInfo !== undefined) {
        updateFields.push(`"processingInfo" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.processingInfo));
      }
      // Handle additional data (merge with existing)
      if (updateData.additionalData !== undefined) {
        updateFields.push(`"additionalData" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.additionalData));
      }
      // Handle soft delete
      if (updateData.deletedAt !== undefined) {
        updateFields.push(`"deletedAt" = $${paramIndex++}`);
        values.push(updateData.deletedAt);
      }
      // Always update the updatedAt timestamp
      updateFields.push(`"updatedAt" = $${paramIndex++}`);
      values.push(new Date().toISOString());
      if (updateFields.length === 1) {
        // Only updatedAt field, no actual changes
        logger.info(`No fields to update for episode: ${episodeId}`);
        return;
      }
      // Add episodeId as the last parameter for WHERE clause
      values.push(episodeId);
      const query = `
        UPDATE public."Episodes" 
        SET ${updateFields.join(', ')}
        WHERE "episodeId" = $${paramIndex}
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

      const updateData = {
        guests: guestNames,
        guestDescriptions: guestDescriptions,
        guestImages: guestImages, 
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
   * Insert a new guest record into the database
   */
  async insertGuest(guest: GuestRecord): Promise<void> {
    const client = this.getClient();
    try {
      const query = `
        INSERT INTO public."Guests" (
          "guestId", "guestName", "guestDescription", "guestImage", "guestLanguage"
        ) VALUES ($1, $2, $3, $4, $5)
      `;
      await client.query(query, [
        guest.guestId || uuidv4(),  
        guest.guestName,
        guest.guestDescription,
        guest.guestImage,
        guest.guestLanguage
      ]);
      logger.info(`Guest inserted/updated: ${guest.guestName}`);
    } catch (error) {
      logger.error('Error inserting/updating guest:', error as Error);
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
    if (!this.guestExtractionService) {
      logger.info(`Guest enrichment not available for episode: ${episodeId}`);
      return null;
    }

    logger.info(`Starting guest enrichment for episode: ${episodeId}`);
    try {
      // Get existing episode data
      const episode = await this.getEpisode(episodeId);
      if (!episode) {
        logger.warn(`Episode ${episodeId} not found for guest enrichment`);
        return null;
      }

      // Use guest extraction service to enrich
      const extractionResult = await this.guestExtractionService.extractPodcastWithBiosAndImages({
        podcast_title: episode.channelName,
        episode_title: episode.episodeTitle,
        episode_description: episode.episodeDescription || ''
      });

      // Insert new guests into DB if not present
      for (const name of extractionResult.guest_names) {
        const guestDetail = extractionResult.guest_details[name];
        if (!guestDetail) continue;
        // Check if guest exists
        const existingGuest = await this.getGuestByName(name);
        if (!existingGuest) {
          await this.insertGuest({
            guestName: name,
            guestDescription: guestDetail.description || '',
            guestImage: guestDetail.image?.s3Url || '',
            guestLanguage: 'en',
          });
        }
      }

      // Update episode with extraction results
      await this.updateEpisodeWithGuestExtraction(episodeId, extractionResult);

      logger.info(`Successfully enriched episode ${episodeId} with ${extractionResult.guest_names.length} guests and ${extractionResult.topics.length} topics`);
      return await this.getEpisode(episodeId); 
    } catch (error) {
      logger.error(`Guest enrichment failed for episode ${episodeId}:`, error as Error);
      return null;
    }
  }
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
    database: process.env.RDS_DATABASE || 'spice_content',
    port: parseInt(process.env.RDS_PORT || '5432'),
    ssl: { rejectUnauthorized: false },
  };

  return new RDSService(config);
}

/**
 * Sanitize description for PostgreSQL storage by normalizing the string,
 * removing control characters, and collapsing whitespace.
 */
function sanitizeDescription(description: string): string {
  if (!description) {
    return '';
  }

  // 1. Normalize to NFC for a consistent Unicode representation. This is a
  // best practice for storing text to avoid issues with characters that
  // can be represented in multiple ways.
  const normalized = description.normalize('NFC');

  // 2. Replace all Unicode control characters (\p{C}), including the null
  // byte (\u0000) that PostgreSQL specifically forbids, with a space.
  // The 'u' flag is required for Unicode property escapes like \p{C}.
  const replaced = normalized.replace(/\p{C}/gu, ' ');

  // 3. Collapse consecutive whitespace characters into a single space
  // and trim any leading or trailing whitespace.
  return replaced.replace(/\s+/g, ' ').trim();
}
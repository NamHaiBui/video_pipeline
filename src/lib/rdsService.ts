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
  episodeImages?: string[]; // S3 URLs for episode images (text[])
  episodeUri?: string; // S3 URL for episode audio/video file
  originalUri: string; // Original source site URL
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
  guestImageUrl?: string[]; // JSON array of S3 URLs for guest images
  
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
  private async getClient(): Promise<Client> {
    if (!this.client) {
      await this.initClient();
    }
    return this.client!;
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
    const client = await this.getClient();
    try {
      // Only select guestName, guestDescription, guestImage, guestLanguage (guestId is not needed for lookup)
      const query = `
        SELECT "guestName", "guestDescription", "guestImage", "guestLanguage"
        FROM public."Guests"
        WHERE "guestName" = $1
      `;
      const result = await client.query(query, [guestName]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      logger.info(`Guest found: ${JSON.stringify(row)}`);
      return {
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
    s3AudioLink:string,
    metadata?: VideoMetadata,
    thumbnailUrl?: string
  ): Promise<{ episodeId: string }> {
    
    const client = await this.getClient();
    
    try {
      // Generate episode ID if not provided
      const episodeId = uuidv4();
      
      // Prepare episode data matching the actual database schema
      const episodeData: Partial<EpisodeRecord> = {
        episodeId,
        episodeTitle: messageBody.episodeTitle,
        episodeDescription: sanitizeDescription(metadata?.description || ''),
        episodeImages: thumbnailUrl ? [thumbnailUrl] : [],
        hostName: messageBody.hostName,
        hostDescription: messageBody.hostDescription,
        channelName: messageBody.channelName,
        channelId: messageBody.channelId,
        originalUri: messageBody.originalUri,
        publishedDate: messageBody.publishedDate,
        episodeUri: s3AudioLink, 
        country: messageBody.country,
        genre: messageBody.genre,
        durationMillis: metadata?.duration ? metadata.duration * 1000 : 0,
        rssUrl: undefined, 
        contentType: messageBody.contentType || 'video',
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
        episodeData.guestImageUrl || [],                      // $9 (text[])
        episodeData.publishedDate ? new Date(episodeData.publishedDate) : null, // $10 (timestamp)
        episodeData.episodeUri,                             // $11 (episodeUri)
        episodeData.originalUri,                            // $12 (originalUri)
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
    const client = await this.getClient();
    
    try {
      logger.info(`Fetching episode: ${episodeId}`);
      
      // Only select necessary attributes for episode lookup
      const query = `
        SELECT "episodeId", "episodeTitle", "episodeDescription", "episodeImages", "episodeUri", "originalUri", "channelId", "channelName", "publishedDate", "createdAt", "updatedAt"
        FROM public."Episodes"
        WHERE "episodeId" = $1
      `;
      const result = await client.query(query, [episodeId]);
      if (result.rows.length === 0) {
        logger.info(`Episode not found: ${episodeId}`);
        return null;
      }
      const row = result.rows[0];
      const episode: Partial<EpisodeRecord> = {
        episodeId: row.episodeId,
        episodeTitle: row.episodeTitle,
        episodeDescription: row.episodeDescription,
        episodeImages: Array.isArray(row.episodeImages) ? row.episodeImages : (row.episodeImages ? [row.episodeImages] : []),
        episodeUri: row.episodeUri,
        originalUri: row.originalUri,
        channelId: row.channelId,
        channelName: row.channelName,
        publishedDate: row.publishedDate,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      logger.info(`Episode fetched successfully: ${episodeId}`);
      return episode as EpisodeRecord;
    } catch (error) {
      logger.error(`Failed to fetch episode ${episodeId}:`, error as Error);
      throw error;
    }
  }

  /**
   * Update episode data
   */
  async updateEpisode(episodeId: string, updateData: Partial<EpisodeRecord>): Promise<void> {

    logger.info(`Updating episode: ${episodeId} with data: ${JSON.stringify(updateData, null, 2)}`);
    
    try {
      const client = await this.getClient();
      logger.info(`RDS client is available: ${!!client}`);
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
      if (updateData.episodeUri !== undefined) {
        updateFields.push(`"episodeUri" = $${paramIndex++}`);
        values.push(updateData.episodeUri);
      }
      if (updateData.originalUri !== undefined) {
        updateFields.push(`"originalUri" = $${paramIndex++}`);
        values.push(updateData.originalUri);
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
        values.push(updateData.guests);
      }
      if (updateData.guestDescriptions !== undefined) {
        updateFields.push(`"guestDescriptions" = $${paramIndex++}`);
        values.push(updateData.guestDescriptions);
      }
      if (updateData.guestImageUrl !== undefined) {
        updateFields.push(`"guestImageUrl" = $${paramIndex++}`);
        values.push(updateData.guestImageUrl);
      }
      if (updateData.topics !== undefined) {
        updateFields.push(`"topics" = $${paramIndex++}`);
        values.push(updateData.topics);
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
        // Fetch existing additionalData from DB
        let existingAdditionalData = {};
        try {
          const result = await client.query(
            'SELECT "additionalData" FROM public."Episodes" WHERE "episodeId" = $1',
            [episodeId]
          );
          if (result.rows.length > 0 && result.rows[0].additionalData) {
            existingAdditionalData = result.rows[0].additionalData;
          }
        } catch (err) {
          logger.warn(`Could not fetch existing additionalData for episode ${episodeId}: ${err}`);
        }
        // Merge new additionalData into existing
        const mergedAdditionalData = { ...existingAdditionalData, ...updateData.additionalData };
        updateFields.push(`"additionalData" = $${paramIndex++}`);
        values.push(JSON.stringify(mergedAdditionalData));
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
        logger.info(`No fields to update for episode: ${episodeId}`);
        return;
      }
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
      logger.info(`Updating episode ${episodeId} with guest extraction results: ${JSON.stringify(extractionResult, null, 2)}`);

      // Prepare guest data for RDS
      const guestNames = extractionResult.guest_names;
      const guestDescriptions = guestNames.map(name => {
        const guestDetail = extractionResult.guest_details[name];
        return guestDetail?.guestDescription || 'No description available';
      });

      // Prepare guest images data
      const guestImageUrl = guestNames.map(name => {
        const guestDetail = extractionResult.guest_details[name];
        if (guestDetail?.guestImage) {
          return guestDetail.guestImage?.s3Url || guestDetail.guestImage || null; 
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
        hasGuestImages: guestImageUrl.length > 0,
        guestImageCount: guestImageUrl.length
      };


      const updateData = {
        guests: guestNames,
        guestDescriptions: guestDescriptions,
        guestImageUrl: guestImageUrl, 
        topics: extractionResult.topics,
        additionalData: {
          guestEnrichmentMetadata: enrichmentMetadata,
          extractedDescription: extractionResult.description
        }
      };

      await this.updateEpisode(episodeId, updateData);
      
      logger.info(`Updated episode ${episodeId} with ${guestNames.length} guests, ${extractionResult.topics.length} topics, and ${guestImageUrl.length} guest images`);
      
    } catch (error) {
      logger.error(`Failed to update episode ${episodeId} with guest extraction results:`, error as Error);
      throw error;
    }
  }
  /**
   * Insert a new guest record into the database
   */
  async insertGuest(guest: GuestRecord): Promise<void> {
    const client = await this.getClient();
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
        if (existingGuest){
          logger.info(existingGuest.guestDescription)
        }
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
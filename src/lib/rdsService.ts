import { Client } from 'pg';
import { VideoMetadata, RDSEpisodeData, EpisodeProcessingInfo } from '../types.js';
import { logger } from './logger.js';
import { GuestEnrichmentService, GuestEnrichmentInput, GuestEnrichmentResult } from './guestEnrichmentService.js';
import { TopicEnrichmentService, TopicEnrichmentInput, TopicEnrichmentResult, extractGuestsWithConfidence, GuestExtractionResult } from './topicEnrichmentService.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Configuration interface for RDS service
 */
export interface RDSConfig {
  /** Database host */
  host: string;
  /** Database user */
  user: string;
  /** Database password */
  password: string;
  /** Database name */
  database: string;
  /** Database port (default: 5432) */
  port?: number;
  /** SSL configuration */
  ssl?: boolean | object;
}

/**
 * Processing information for episodes
 */
export interface ProcessingInfo extends EpisodeProcessingInfo {}

/**
 * Episode record structure for RDS storage - same as RDSEpisodeData
 */
export interface EpisodeRecord extends RDSEpisodeData {}

/**
 * SQS message body structure (no guest/topic info - comes from enrichment)
 */
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

/**
 * Input interface for creating episodes (some fields auto-generated)
 */
export interface CreateEpisodeInput {
  episodeId: string;
  episodeTitle: string;
  episodeDescription: string;
  hostName?: string;
  hostDescription?: string;
  channelName: string;
  guests?: string[];
  guestDescriptions?: string[];
  guestImageUrl?: string;
  publishedDate: Date;
  episodeUri?: string;
  originalUri: string;
  channelId: string;
  country?: string;
  genre?: string;
  episodeImages?: string[];
  durationMillis: number;
  rssUrl?: string;
  transcriptUri?: string;
  processedTranscriptUri?: string;
  summaryAudioUri?: string;
  summaryDurationMillis?: number;
  summaryTranscriptUri?: string;
  topics?: string[];
  processingInfo?: Partial<EpisodeProcessingInfo>;
  contentType: 'Audio' | 'Video';
  additionalData?: Record<string, any>;
  processingDone?: boolean;
  isSynced?: boolean;
}

/**
 * Update interface for episodes (all fields optional except ID)
 */
export interface UpdateEpisodeInput {
  episodeTitle?: string;
  episodeDescription?: string;
  hostName?: string;
  hostDescription?: string;
  channelName?: string;
  guests?: string[];
  guestDescriptions?: string[];
  guestImageUrl?: string;
  publishedDate?: Date;
  episodeUri?: string;
  originalUri?: string;
  channelId?: string;
  country?: string;
  genre?: string;
  episodeImages?: string[];
  durationMillis?: number;
  rssUrl?: string;
  transcriptUri?: string;
  processedTranscriptUri?: string;
  summaryAudioUri?: string;
  summaryDurationMillis?: number;
  summaryTranscriptUri?: string;
  topics?: string[];
  processingInfo?: Partial<EpisodeProcessingInfo>;
  contentType?: 'Audio' | 'Video';
  additionalData?: Record<string, any>;
  processingDone?: boolean;
  isSynced?: boolean;
}

/**
 * RDS service class for episode operations
 */
export class RDSService {
  private config: RDSConfig;
  private guestEnrichmentService: GuestEnrichmentService;
  private topicEnrichmentService: TopicEnrichmentService;

  constructor(config: RDSConfig) {
    this.config = config;
    this.guestEnrichmentService = new GuestEnrichmentService();
    this.topicEnrichmentService = new TopicEnrichmentService();
  }

  /**
   * Create a new database client connection
   */
  private async createClient(): Promise<Client> {
    const client = new Client({
      host: this.config.host,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      port: this.config.port || 5432,
      ssl: this.config.ssl || { rejectUnauthorized: false },
    });

    await client.connect();
    return client;
  }

  /**
   * Execute a query with automatic connection management
   */
  private async executeQuery<T = any>(query: string, params?: any[]): Promise<T[]> {
    const client = await this.createClient();
    try {
      const result = await client.query(query, params);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  /**
   * Create a new episode record
   */
  async createEpisode(episodeData: CreateEpisodeInput): Promise<EpisodeRecord> {
    logger.info(`Creating episode: ${episodeData.episodeTitle}`);

    const defaultProcessingInfo: EpisodeProcessingInfo = {
      episodeTranscribingDone: false,
      summaryTranscribingDone: false,
      summarizingDone: false,
      numChunks: 0,
      numRemovedChunks: 0,
      chunkingDone: false,
      quotingDone: false,
      ...episodeData.processingInfo
    };

    const now = new Date();
    
    const query = `
      INSERT INTO "Episodes" (
        "episodeId", "episodeTitle", "episodeDescription", "hostName", "hostDescription",
        "channelName", "guests", "guestDescriptions", "guestImageUrl", "publishedDate",
        "episodeUri", "originalUri", "channelId", "country", "genre", "episodeImages",
        "durationMillis", "rssUrl", "transcriptUri", "processedTranscriptUri",
        "summaryAudioUri", "summaryDurationMillis", "summaryTranscriptUri", "topics",
        "updatedAt", "createdAt", "processingInfo", "contentType", "additionalData",
        "processingDone", "isSynced"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
      ) RETURNING *
    `;

    const params = [
      episodeData.episodeId,
      episodeData.episodeTitle,
      episodeData.episodeDescription,
      episodeData.hostName,
      episodeData.hostDescription,
      episodeData.channelName,
      episodeData.guests || [],
      episodeData.guestDescriptions || [],
      episodeData.guestImageUrl,
      episodeData.publishedDate,
      episodeData.episodeUri,
      episodeData.originalUri,
      episodeData.channelId,
      episodeData.country,
      episodeData.genre,
      episodeData.episodeImages || [],
      episodeData.durationMillis,
      episodeData.rssUrl,
      episodeData.transcriptUri,
      episodeData.processedTranscriptUri,
      episodeData.summaryAudioUri,
      episodeData.summaryDurationMillis,
      episodeData.summaryTranscriptUri,
      episodeData.topics || [],
      now, // updatedAt
      now, // createdAt
      JSON.stringify(defaultProcessingInfo),
      episodeData.contentType,
      JSON.stringify(episodeData.additionalData || {}),
      episodeData.processingDone || false,
      episodeData.isSynced || false
    ];

    const result = await this.executeQuery<EpisodeRecord>(query, params);
    logger.info(`✅ Created episode: ${episodeData.episodeTitle}`);
    return result[0];
  }

  /**
   * Get an episode by ID
   */
  async getEpisode(episodeId: string): Promise<EpisodeRecord | null> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "episodeId" = $1 AND "deletedAt" IS NULL
    `;
    
    const result = await this.executeQuery<EpisodeRecord>(query, [episodeId]);
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Update an episode
   */
  async updateEpisode(episodeId: string, updateData: UpdateEpisodeInput): Promise<EpisodeRecord | null> {
    logger.info(`Updating episode: ${episodeId}`);

    // Build dynamic update query
    const updateFields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    Object.entries(updateData).forEach(([key, value]) => {
      if (value !== undefined) {
        if (['guests', 'guestDescriptions', 'episodeImages', 'topics', 'additionalData'].includes(key)) {
          updateFields.push(`"${key}" = $${paramIndex}`);
          params.push(JSON.stringify(value));
        } else if (key === 'processingInfo') {
          // Merge with existing processing info
          updateFields.push(`"processingInfo" = "processingInfo" || $${paramIndex}::jsonb`);
          params.push(JSON.stringify(value));
        } else {
          updateFields.push(`"${key}" = $${paramIndex}`);
          params.push(value);
        }
        paramIndex++;
      }
    });

    if (updateFields.length === 0) {
      logger.warn('No fields to update');
      return await this.getEpisode(episodeId);
    }

    // Always update updatedAt
    updateFields.push(`"updatedAt" = $${paramIndex}`);
    params.push(new Date());
    paramIndex++;

    // Add episodeId as the last parameter
    params.push(episodeId);

    const query = `
      UPDATE "Episodes" 
      SET ${updateFields.join(', ')}
      WHERE "episodeId" = $${paramIndex} AND "deletedAt" IS NULL
      RETURNING *
    `;

    const result = await this.executeQuery<EpisodeRecord>(query, params);
    
    if (result.length > 0) {
      logger.info(`✅ Updated episode: ${episodeId}`);
      return result[0];
    } else {
      logger.warn(`Episode not found: ${episodeId}`);
      return null;
    }
  }

  /**
   * Delete an episode (soft delete)
   */
  async deleteEpisode(episodeId: string): Promise<boolean> {
    logger.info(`Soft deleting episode: ${episodeId}`);

    const query = `
      UPDATE "Episodes" 
      SET "deletedAt" = $1, "updatedAt" = $1
      WHERE "episodeId" = $2 AND "deletedAt" IS NULL
      RETURNING "episodeId"
    `;

    const result = await this.executeQuery(query, [new Date(), episodeId]);
    
    if (result.length > 0) {
      logger.info(`✅ Soft deleted episode: ${episodeId}`);
      return true;
    } else {
      logger.warn(`Episode not found for deletion: ${episodeId}`);
      return false;
    }
  }

  /**
   * Get episodes by channel ID
   */
  async getEpisodesByChannel(channelId: string, limit: number = 50, offset: number = 0): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "channelId" = $1 AND "deletedAt" IS NULL
      ORDER BY "publishedDate" DESC
      LIMIT $2 OFFSET $3
    `;
    
    return await this.executeQuery<EpisodeRecord>(query, [channelId, limit, offset]);
  }

  /**
   * Get episodes by channel name (since channel info comes from SQS)
   */
  async getEpisodesByChannelName(channelName: string, limit: number = 50, offset: number = 0): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "channelName" = $1 AND "deletedAt" IS NULL
      ORDER BY "publishedDate" DESC
      LIMIT $2 OFFSET $3
    `;
    
    return await this.executeQuery<EpisodeRecord>(query, [channelName, limit, offset]);
  }

  /**
   * Get episodes by processing status
   */
  async getEpisodesByProcessingStatus(processingDone: boolean = false, limit: number = 50): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "processingDone" = $1 AND "deletedAt" IS NULL
      ORDER BY "createdAt" ASC
      LIMIT $2
    `;
    
    return await this.executeQuery<EpisodeRecord>(query, [processingDone, limit]);
  }

  /**
   * Get episodes by genre (from SQS channel info)
   */
  async getEpisodesByGenre(genre: string, limit: number = 50, offset: number = 0): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "genre" = $1 AND "deletedAt" IS NULL
      ORDER BY "publishedDate" DESC
      LIMIT $2 OFFSET $3
    `;
    
    return await this.executeQuery<EpisodeRecord>(query, [genre, limit, offset]);
  }

  /**
   * Get episodes by country (from SQS channel info)
   */
  async getEpisodesByCountry(country: string, limit: number = 50, offset: number = 0): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "country" = $1 AND "deletedAt" IS NULL
      ORDER BY "publishedDate" DESC
      LIMIT $2 OFFSET $3
    `;
    
    return await this.executeQuery<EpisodeRecord>(query, [country, limit, offset]);
  }

  /**
   * Search episodes by title or description
   */
  async searchEpisodes(searchTerm: string, limit: number = 50): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE ("episodeTitle" ILIKE $1 OR "episodeDescription" ILIKE $1) 
        AND "deletedAt" IS NULL
      ORDER BY "publishedDate" DESC
      LIMIT $2
    `;
    
    const searchPattern = `%${searchTerm}%`;
    return await this.executeQuery<EpisodeRecord>(query, [searchPattern, limit]);
  }

  /**
   * Process VideoMetadata and SQS message body to create episode record
   */
  processEpisodeMetadata(
    videoMetadata: VideoMetadata, 
    audioS3Link: string, 
    channelInfo: SQSMessageBody
  ): CreateEpisodeInput {
    return {
      episodeId: videoMetadata.id,
      episodeTitle: videoMetadata.title,
      episodeDescription: videoMetadata.description || '',
      hostName: channelInfo.hostName,
      hostDescription: channelInfo.hostDescription,
      channelName: channelInfo.channelName,
      guests: [], // Always empty - comes from enrichment
      guestDescriptions: [], // Always empty - comes from enrichment
      guestImageUrl: undefined, // Will be set during enrichment if needed
      publishedDate: this.parseVideoDate(videoMetadata.upload_date) || new Date(),
      episodeUri: audioS3Link,
      originalUri: videoMetadata.webpage_url,
      channelId: channelInfo.channelId,
      country: channelInfo.country,
      genre: channelInfo.genre,
      episodeImages: videoMetadata.thumbnail ? [videoMetadata.thumbnail] : [], // Always from video thumbnail
      durationMillis: videoMetadata.duration * 1000,
      rssUrl: channelInfo.additionalData?.rssUrl,
      transcriptUri: '', // Will be populated during processing
      processedTranscriptUri: '', // Will be populated during processing
      summaryAudioUri: '', // Will be populated during processing
      summaryDurationMillis: 0, // Will be populated during processing
      summaryTranscriptUri: '', // Will be populated during processing
      topics: [], // Always empty - comes from enrichment
      contentType: 'Video', // Always Video
      additionalData: {
        viewCount: videoMetadata.view_count,
        likeCount: videoMetadata.like_count,
        originalVideoId: videoMetadata.id,
        extractor: videoMetadata.extractor,
        thumbnail: videoMetadata.thumbnail,
        ...channelInfo.additionalData
      }
    };
  }

  /**
   * Helper method to parse video date
   */
  private parseVideoDate(dateString: string): Date | null {
    if (!dateString) return null;
    
    try {
      // Handle YouTube date format (YYYYMMDD)
      if (/^\d{8}$/.test(dateString)) {
        const year = dateString.substring(0, 4);
        const month = dateString.substring(4, 6);
        const day = dateString.substring(6, 8);
        return new Date(`${year}-${month}-${day}`);
      }
      
      // Try parsing the string normally
      const date = new Date(dateString);
      return isNaN(date.getTime()) ? null : date;
    } catch (error) {
      logger.error(`Failed to parse date: ${dateString}`, error as Error);
      return null;
    }
  }

  /**
   * Get episode count by channel
   */
  async getEpisodeCountByChannel(channelId: string): Promise<number> {
    const query = `
      SELECT COUNT(*) as count FROM "Episodes" 
      WHERE "channelId" = $1 AND "deletedAt" IS NULL
    `;
    
    const result = await this.executeQuery<{ count: string }>(query, [channelId]);
    return parseInt(result[0].count);
  }

  /**
   * Get recent episodes
   */
  async getRecentEpisodes(limit: number = 50): Promise<EpisodeRecord[]> {
    const query = `
      SELECT * FROM "Episodes" 
      WHERE "deletedAt" IS NULL
      ORDER BY "publishedDate" DESC
      LIMIT $1
    `;
    
    return await this.executeQuery<EpisodeRecord>(query, [limit]);
  }

  /**
   * Extract and validate channel information from SQS message body
   */
  static extractChannelInfoFromSQS(sqsMessageBody: any): SQSMessageBody {
    // Handle both new message format (direct fields) and old format (channelInfo object)
    let channelData = sqsMessageBody;
    if (sqsMessageBody.channelInfo) {
      channelData = { ...sqsMessageBody, ...sqsMessageBody.channelInfo };
    }

    if (!channelData.channelId || !channelData.channelName) {
      throw new Error('SQS message must contain channelId and channelName');
    }

    return {
      videoId: channelData.videoId || '',
      episodeTitle: channelData.episodeTitle || '',
      channelName: channelData.channelName,
      channelId: channelData.channelId,
      originalUri: channelData.originalUri || '',
      publishedDate: channelData.publishedDate || '',
      contentType: 'Video', // Always Video for new structure
      hostName: channelData.hostName || '',
      hostDescription: channelData.hostDescription || '',
      genre: channelData.genre || channelData.genreId || '', // Support both 'genre' and 'genreId' keys
      country: channelData.country || '',
      websiteLink: channelData.websiteLink || '',
      additionalData: {
        youtubeVideoId: channelData.videoId || '',
        youtubeChannelId: channelData.channelId || '',
        youtubeUrl: channelData.originalUri || '',
        notificationReceived: new Date().toISOString(),
        channelDescription: channelData.channelDescription,
        channelThumbnail: channelData.channelThumbnail,
        subscriberCount: channelData.subscriberCount,
        verified: channelData.verified || false,
        rssUrl: channelData.rssUrl,
        ...(channelData.additionalData || {})
      }
    };
  }

  /**
   * Process complete episode from SQS message and video metadata
   */
  async processEpisodeFromSQS(
    sqsMessageBody: any,
    videoMetadata: VideoMetadata,
    audioS3Link: string,
    enrichGuests: boolean = true,
    enrichTopics: boolean = true
  ): Promise<EpisodeRecord> {
    const channelInfo = RDSService.extractChannelInfoFromSQS(sqsMessageBody);
    const episodeInput = this.processEpisodeMetadata(videoMetadata, audioS3Link, channelInfo);
    
    // Check if episode already exists
    const existingEpisode = await this.getEpisode(episodeInput.episodeId);
    let episode: EpisodeRecord;
    
    if (existingEpisode) {
      logger.info(`Episode already exists, updating: ${episodeInput.episodeId}`);
      episode = await this.updateEpisode(episodeInput.episodeId, episodeInput) || existingEpisode;
    } else {
      episode = await this.createEpisode(episodeInput);
    }
    
    // Enrich guest information if requested (includes fallback logic for when service is unavailable)
    if (enrichGuests) {
      try {
        const enrichedEpisode = await this.enrichGuestInfo(episode.episodeId);
        if (enrichedEpisode) {
          episode = enrichedEpisode;
        }
      } catch (error: any) {
        logger.warn(`Failed to enrich guests for episode ${episode.episodeId}: ${error.message}`);
        // Continue without guest enrichment
      }
    }
    
    // Enrich topic information if requested (includes fallback logic for when service is unavailable)
    if (enrichTopics) {
      try {
        const enrichedEpisode = await this.enrichTopicInfo(episode.episodeId);
        if (enrichedEpisode) {
          episode = enrichedEpisode;
        }
      } catch (error: any) {
        logger.warn(`Failed to enrich topics for episode ${episode.episodeId}: ${error.message}`);
        // Continue without topic enrichment
      }
    }
    
    return episode;
  }

  /**
   * Update episode with new channel information from SQS
   */
  async updateEpisodeChannelInfo(episodeId: string, channelInfo: SQSMessageBody): Promise<EpisodeRecord | null> {
    const updateData: UpdateEpisodeInput = {
      channelName: channelInfo.channelName,
      hostName: channelInfo.hostName,
      hostDescription: channelInfo.hostDescription,
      country: channelInfo.country,
      genre: channelInfo.genre,
      additionalData: channelInfo.additionalData
    };

    return await this.updateEpisode(episodeId, updateData);
  }

  /**
   * Enrich guest information for an episode using AI
   */
  async enrichGuestInfo(episodeId: string): Promise<EpisodeRecord | null> {
    logger.info(`🔍 Enriching guest info for episode: ${episodeId}`);

    // Get the episode data
    const episode = await this.getEpisode(episodeId);
    if (!episode) {
      logger.warn(`Episode not found for enrichment: ${episodeId}`);
      return null;
    }

    // Check if guest enrichment service is available
    if (!this.guestEnrichmentService.isAvailable()) {
      logger.warn(`Guest enrichment service not available for episode: ${episodeId}, attempting fallback guest extraction`);
      
      // Even without AI, we can still try to extract guest names from metadata
      const existingGuests = episode.guests || [];
      if (existingGuests.length === 0) {
        const guestExtraction = extractGuestsWithConfidence(
          episode.episodeTitle,
          episode.episodeDescription,
          episode.hostName
        );
        
        if (guestExtraction.guest_names.length > 0) {
          // Update episode with extracted guest names (without descriptions)
          const updateData: UpdateEpisodeInput = {
            guests: guestExtraction.guest_names,
            additionalData: {
              ...episode.additionalData,
              guestEnrichment: {
                enrichedAt: new Date().toISOString(),
                method: 'fallback_extraction',
                successCount: guestExtraction.guest_names.length,
                totalCount: guestExtraction.guest_names.length,
                confidence: guestExtraction.confidence,
                isCompilation: guestExtraction.is_compilation,
                hasMultipleGuests: guestExtraction.has_multiple_guests,
                summary: guestExtraction.summary
              }
            }
          };
          
          await this.updateEpisode(episodeId, updateData);
          logger.info(`✅ Extracted ${guestExtraction.guest_names.length} guest names using enhanced fallback method for episode: ${episodeId} (confidence: ${guestExtraction.confidence})`);
          return await this.getEpisode(episodeId);
        }
      }
      
      return episode;
    }

    // Extract existing guest names
    const existingGuests = episode.guests || [];
    if (existingGuests.length === 0) {
      // Try to extract guest names from metadata
      const extractedGuests = await GuestEnrichmentService.extractGuestNamesFromMetadata(
        episode.episodeTitle,
        episode.episodeDescription
      );
      
      if (extractedGuests.length === 0) {
        logger.info(`No guests found to enrich for episode: ${episodeId}`);
        return episode;
      }

      // Update episode with extracted guest names first
      await this.updateEpisode(episodeId, { guests: extractedGuests });
      episode.guests = extractedGuests;
    }

    // Prepare guest enrichment inputs
    const guestInputs: GuestEnrichmentInput[] = (episode.guests || []).map(guestName => ({
      name: guestName,
      podcastTitle: episode.channelName,
      episodeTitle: episode.episodeTitle
    }));

    // Enrich guest information
    const enrichmentResults = await this.guestEnrichmentService.enrichGuests(guestInputs);

    // Filter successful results
    const successfulResults = enrichmentResults.filter(result => result.status === 'success');
    
    if (successfulResults.length === 0) {
      logger.warn(`No successful guest enrichments for episode: ${episodeId}`);
      return episode;
    }

    // Update episode with enriched guest data
    const enrichedGuestNames = successfulResults.map(result => result.name);
    const enrichedGuestDescriptions = successfulResults.map(result => result.description);

    const updateData: UpdateEpisodeInput = {
      guests: enrichedGuestNames,
      guestDescriptions: enrichedGuestDescriptions,
      // Store enrichment metadata in additionalData
      additionalData: {
        ...episode.additionalData,
        guestEnrichment: {
          enrichedAt: new Date().toISOString(),
          successCount: successfulResults.length,
          totalCount: enrichmentResults.length,
          confidenceStats: {
            high: successfulResults.filter(r => r.confidence === 'high').length,
            medium: successfulResults.filter(r => r.confidence === 'medium').length,
            low: successfulResults.filter(r => r.confidence === 'low').length
          }
        }
      }
    };

    await this.updateEpisode(episodeId, updateData);

    logger.info(`✅ Enriched ${successfulResults.length}/${enrichmentResults.length} guests for episode: ${episodeId}`);
    return await this.getEpisode(episodeId);
  }

  /**
   * Enrich topic information for an episode using AI
   */
  async enrichTopicInfo(episodeId: string): Promise<EpisodeRecord | null> {
    logger.info(`🔍 Enriching topic info for episode: ${episodeId}`);

    // Get the episode data
    const episode = await this.getEpisode(episodeId);
    if (!episode) {
      logger.warn(`Episode not found for topic enrichment: ${episodeId}`);
      return null;
    }

    // Check if topic enrichment service is available
    if (!this.topicEnrichmentService.isAvailable()) {
      logger.warn(`Topic enrichment service not available for episode: ${episodeId}, using fallback topic generation`);
      
      // Generate fallback topics
      const fallbackTopics = this.topicEnrichmentService.generateFallbackTopics({
        episodeTitle: episode.episodeTitle,
        episodeDescription: episode.episodeDescription,
        channelName: episode.channelName,
        hostName: episode.hostName,
        guests: episode.guests
      });

      if (fallbackTopics.length > 0) {
        const updateData: UpdateEpisodeInput = {
          topics: fallbackTopics,
          additionalData: {
            ...episode.additionalData,
            topicEnrichment: {
              enrichedAt: new Date().toISOString(),
              method: 'fallback_generation',
              confidence: 'low',
              topicCount: fallbackTopics.length,
              reason: 'AI service not available'
            }
          }
        };
        
        await this.updateEpisode(episodeId, updateData);
        logger.info(`✅ Generated ${fallbackTopics.length} fallback topics for episode: ${episodeId}`);
      } else {
        logger.warn(`⚠️ No fallback topics could be generated for episode: ${episodeId}`);
      }

      return await this.getEpisode(episodeId);
    }

    // Prepare topic enrichment input
    const topicInput: TopicEnrichmentInput = {
      episodeTitle: episode.episodeTitle,
      episodeDescription: episode.episodeDescription,
      channelName: episode.channelName,
      hostName: episode.hostName,
      guests: episode.guests
    };

    // Enrich topic information
    const enrichmentResult = await this.topicEnrichmentService.enrichTopics(topicInput);

    if (enrichmentResult.status !== 'success' || enrichmentResult.topics.length === 0) {
      logger.warn(`Topic enrichment failed for episode: ${episodeId}, using fallback`);
      
      // Use fallback topics if LLM enrichment fails
      const fallbackTopics = this.topicEnrichmentService.generateFallbackTopics(topicInput);
      
      const updateData: UpdateEpisodeInput = {
        topics: fallbackTopics,
        additionalData: {
          ...episode.additionalData,
          topicEnrichment: {
            enrichedAt: new Date().toISOString(),
            method: 'fallback',
            confidence: 'low',
            errorMessage: enrichmentResult.errorMessage
          }
        }
      };

      await this.updateEpisode(episodeId, updateData);
      logger.info(`✅ Generated ${fallbackTopics.length} fallback topics for episode: ${episodeId}`);
      return await this.getEpisode(episodeId);
    }

    // Update episode with enriched topic data
    const updateData: UpdateEpisodeInput = {
      topics: enrichmentResult.topics,
      additionalData: {
        ...episode.additionalData,
        topicEnrichment: {
          enrichedAt: new Date().toISOString(),
          method: 'llm',
          confidence: enrichmentResult.confidence,
          topicCount: enrichmentResult.topics.length
        }
      }
    };

    await this.updateEpisode(episodeId, updateData);

    logger.info(`✅ Enriched ${enrichmentResult.topics.length} topics for episode: ${episodeId} (confidence: ${enrichmentResult.confidence})`);
    return await this.getEpisode(episodeId);
  }

  /**
   * Enrich both guest and topic information for an episode
   */
  async enrichEpisodeInfo(episodeId: string, options: { enrichGuests?: boolean; enrichTopics?: boolean } = {}): Promise<EpisodeRecord | null> {
    const { enrichGuests = true, enrichTopics = true } = options;
    
    logger.info(`🔍 Starting full episode enrichment for: ${episodeId} (guests: ${enrichGuests}, topics: ${enrichTopics})`);

    let episode = await this.getEpisode(episodeId);
    if (!episode) {
      logger.warn(`Episode not found for enrichment: ${episodeId}`);
      return null;
    }

    // Enrich guests first if requested
    if (enrichGuests) {
      episode = await this.enrichGuestInfo(episodeId);
      if (!episode) {
        logger.error(`Failed to enrich guests for episode: ${episodeId}`);
        return null;
      }
    }

    // Then enrich topics if requested
    if (enrichTopics) {
      episode = await this.enrichTopicInfo(episodeId);
      if (!episode) {
        logger.error(`Failed to enrich topics for episode: ${episodeId}`);
        return null;
      }
    }

    logger.info(`✅ Completed full episode enrichment for: ${episodeId}`);
    return episode;
  }
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
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };

  return new RDSService(config);
}

import { Client, Pool, PoolClient } from 'pg';
import { withSemaphore, dbSemaphore } from './utils/concurrency.js';
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
  // Connection pool settings
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export interface SQSMessageBody {
  videoId: string;
  episodeTitle: string;
  channelName: string;
  channelId: string;
  originalUri: string;
  publishedDate: string;
  contentType: 'video';
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
  
  guests?: string[]; // PostgreSQL text[] array
  guestDescriptions?: string[]; // PostgreSQL text[] array
  guestImageUrl?: string[]; // JSON string stored in text field
  
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
  
  contentType: 'video';
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
 * PostgreSQL-based RDS Service for managing podcast episode data with ACID compliance
 * 
 * ACID Properties Implemented:
 * - Atomicity: All database operations are wrapped in transactions that either complete fully or rollback completely
 * - Consistency: All data validation and constraints are enforced before committing transactions
 * - Isolation: READ COMMITTED isolation level prevents dirty reads, with row-level locking for critical operations
 * - Durability: PostgreSQL's WAL ensures committed transactions survive system failures
 * 
 * Additional Features:
 * - Connection pooling for better performance and resource management
 * - Automatic retry logic for transient failures (deadlocks, serialization failures)
 * - Duplicate episode detection with proper locking to prevent race conditions
 * - Comprehensive error handling with transaction rollback on failures
 */
export class RDSService {
  
  
  private config: RDSConfig;
  private guestExtractionService?: GuestExtractionService;
  private client: Client | null = null;
  private pool: Pool | null = null;
  private usePool: boolean = false;

  constructor(config: RDSConfig, guestExtractionService?: GuestExtractionService, usePool: boolean = false) {
    this.config = config;
    this.guestExtractionService = guestExtractionService;
    this.usePool = usePool;
  }

  /**
   * Initialize the connection pool (recommended for production)
   */
  async initPool(): Promise<void> {
    if (this.pool) return;
    
    const poolConfig = {
      host: this.config.host,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      port: this.config.port,
      ssl: this.config.ssl,
      max: this.config.max || 20,                          // Maximum number of clients in the pool
      idleTimeoutMillis: this.config.idleTimeoutMillis || 30000,     // Close idle clients after 30 seconds
      connectionTimeoutMillis: this.config.connectionTimeoutMillis || 2000,  // Return error after 2 seconds if connection cannot be established
    };
    
    this.pool = new Pool(poolConfig);
    this.usePool = true;
    
    // Handle pool errors
    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client in pool:', err);
    });
    
    logger.info('PostgreSQL connection pool initialized');
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
   * Use either the connection pool or a single client for queries
   */
  private async getClient(): Promise<Client | PoolClient> {
    if (this.usePool && this.pool) {
      // Return a client from the pool - it will be automatically returned when done
      return this.pool.connect();
    } else {
      // Use single client connection
      if (!this.client) {
        await this.initClient();
      }
      return this.client!;
    }
  }

  /**
   * Release a client back to the pool (only needed when using pool)
   */
  private releaseClient(client: Client | PoolClient): void {
    if (this.usePool && this.pool && 'release' in client) {
      (client as PoolClient).release();
    }
  }

  /**
   * Deep-ish equality for arrays/objects/primitives used in validation.
   * Arrays are compared by length and ordered elements; objects by shallow keys and primitive equality.
   */
  private deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      for (const k of aKeys) {
        if (!this.deepEqual(a[k], (b as any)[k])) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Independently validate that an episode has expected updates applied.
   * Only fields present in `expected` are validated; others are ignored.
   * For additionalData, ensures keys exist and values match when provided (primitives); for nested objects, presence check.
   */
  private async validateEpisodeUpdate(episodeId: string, expected: Partial<EpisodeRecord>): Promise<boolean> {
    try {
      const current = await this.getEpisode(episodeId);
      if (!current) {
        logger.warn(`Validation failed: episode ${episodeId} not found`);
        return false;
      }

      let ok = true;
      const fail = (field: string, details?: any) => {
        ok = false;
        logger.warn(`Validation mismatch for ${episodeId} on field '${field}'`, details);
      };

      const checkPrimitive = (key: keyof EpisodeRecord) => {
        const expVal = (expected as any)[key];
        if (expVal === undefined) return; // not part of validation
        const curVal = (current as any)[key];
        if (key === 'contentType') {
          // Compare case-insensitively and trimmed for safety
          const a = typeof expVal === 'string' ? expVal.trim().toLowerCase() : expVal;
          const b = typeof curVal === 'string' ? curVal.trim().toLowerCase() : curVal;
          if (a !== b) fail(String(key), { expected: expVal, actual: curVal });
          return;
        }
        if (expVal !== curVal) fail(String(key), { expected: expVal, actual: curVal });
      };

      const checkArray = (key: keyof EpisodeRecord) => {
        const expVal = (expected as any)[key];
        if (expVal === undefined) return;
        const curVal = (current as any)[key];
        if (!Array.isArray(expVal) || !Array.isArray(curVal) || !this.deepEqual(expVal, curVal)) {
          fail(String(key), { expected: expVal, actual: curVal });
        }
      };

      // Validate basic primitives when provided
      [
        'episodeTitle','episodeDescription','hostName','hostDescription','episodeUri','originalUri',
        'contentType','country','genre','durationMillis','rssUrl','processingDone','isSynced',
        'transcriptUri','processedTranscriptUri','summaryAudioUri','summaryDurationMillis','summaryTranscriptUri'
      ].forEach(k => checkPrimitive(k as keyof EpisodeRecord));

      // Validate array fields
      ['guests','guestDescriptions','topics','episodeImages'].forEach(k => checkArray(k as keyof EpisodeRecord));

      // Validate additionalData minimally
      if (expected.additionalData !== undefined) {
        const expAD = expected.additionalData || {};
        const curAD = current.additionalData || {};

        for (const [k, v] of Object.entries(expAD)) {
          if (!(k in curAD)) {
            fail(`additionalData.${k}`, { expected: v, actual: undefined });
            continue;
          }
          const curV = (curAD as any)[k];
          // If expected value is object, only check presence of the key
          if (v !== null && typeof v === 'object') {
            // presence already checked; optionally ensure same type
            if (typeof curV !== 'object') fail(`additionalData.${k}`, { expectedType: typeof v, actualType: typeof curV });
          } else if (v !== undefined) {
            // primitive compare when provided
            if (v !== curV) fail(`additionalData.${k}`, { expected: v, actual: curV });
          }
        }
      }

      return ok;
    } catch (err) {
      logger.warn(`Validation error for episode ${episodeId}: ${(err as any)?.message || String(err)}`);
      return false;
    }
  }

  /**
   * Gracefully close all connections (call on server shutdown)
   */
  async closeClient(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.end();
        logger.info('PostgreSQL connection pool closed');
        this.pool = null;
      }
      
      if (this.client) {
        await this.client.end();
        logger.info('PostgreSQL single client connection closed');
        this.client = null;
      }
    } catch (error) {
      logger.error('Error closing PostgreSQL connections:', error as Error);
    }
  }
  /**
   * Check if an episode with the same title already exists for a channel
   * Returns the episode record with processing status information
   */
  async checkEpisodeExists(episodeTitle: string, channelId: string): Promise<EpisodeRecord | null> {
    let client: Client | PoolClient | null = null;
    try {
      client = await this.getClient();
      logger.info(`Checking if episode exists: "${episodeTitle}" for channel: ${channelId}`);
      
      const query = `
        SELECT "episodeId", "episodeTitle", "channelId", "channelName", "originalUri", "createdAt", "additionalData"
        FROM public."Episodes"
        WHERE "episodeTitle" = $1 AND "channelId" = $2 AND "deletedAt" IS NULL
        ORDER BY "createdAt" DESC
        LIMIT 1
      `;
      
      const result = await client.query(query, [sanitizeText(episodeTitle), channelId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        logger.info(`Found existing episode: ${row.episodeId} - "${row.episodeTitle}"`);
        
        // Parse additionalData to check processing status
        const additionalData = row.additionalData || {};
        const hasVideoLocation = additionalData.videoLocation !== undefined;
        const hasMasterM3u8 = additionalData.master_m3u8 !== undefined;
        
        logger.info(`Episode processing status check:`, {
          episodeId: row.episodeId,
          hasVideoLocation,
          hasMasterM3u8,
          shouldSkipProcessing: hasVideoLocation && hasMasterM3u8,
          shouldRerunProcessing: hasVideoLocation && !hasMasterM3u8
        });
        
        const episode = {
          episodeId: row.episodeId,
          episodeTitle: row.episodeTitle,
          channelId: row.channelId,
          channelName: row.channelName,
          originalUri: row.originalUri,
          createdAt: row.createdAt,
          additionalData: additionalData,
        } as EpisodeRecord;
        
        this.releaseClient(client);
        return episode;
      }
      
      this.releaseClient(client);
      return null;
    } catch (error: any) {
      if (client) {
        this.releaseClient(client);
      }
      logger.error('Error checking episode existence:', error as Error);
      throw error;
    }
  }

  /**
   * Check episode processing status based on additionalData keys
   * Returns detailed processing status information
   */
  async checkEpisodeProcessingStatus(episodeTitle: string, channelId: string): Promise<{
    exists: boolean;
    episode?: EpisodeRecord;
    shouldSkipProcessing: boolean;
    shouldRerunProcessing: boolean;
    reason: string;
  }> {
    const episode = await this.checkEpisodeExists(episodeTitle, channelId);
    
    if (!episode) {
      return {
        exists: false,
        shouldSkipProcessing: false,
        shouldRerunProcessing: false,
        reason: 'Episode does not exist'
      };
    }
    
    const additionalData = episode.additionalData || {};
    const hasVideoLocation = additionalData.videoLocation !== undefined;
    const hasMasterM3u8 = additionalData.master_m3u8 !== undefined;
    
    if (hasVideoLocation && hasMasterM3u8) {
      return {
        exists: true,
        episode,
        shouldSkipProcessing: true,
        shouldRerunProcessing: false,
        reason: 'Episode exists with both videoLocation and master_m3u8 keys - processing complete'
      };
    }
    
    if (hasVideoLocation && !hasMasterM3u8) {
      return {
        exists: true,
        episode,
        shouldSkipProcessing: false,
        shouldRerunProcessing: true,
        reason: 'Episode exists with videoLocation but missing master_m3u8 key - needs reprocessing'
      };
    }
    
    return {
      exists: true,
      episode,
      shouldSkipProcessing: false,
      shouldRerunProcessing: false,
      reason: 'Episode exists but no videoLocation key found - standard processing needed'
    };
  }

  /**
   * Check if an episode with the same youtubeVideoId already exists
   * Returns the episode record if found
   */
  async checkEpisodeExistsByYoutubeVideoId(youtubeVideoId: string): Promise<EpisodeRecord | null> {
    let client: Client | PoolClient | null = null;
    try {
      client = await this.getClient();
      logger.info(`Checking if episode exists by youtubeVideoId: ${youtubeVideoId}`);
      
      const query = `
        SELECT "episodeId", "episodeTitle", "channelId", "channelName", "originalUri", "createdAt", "additionalData"
        FROM public."Episodes"
        WHERE "additionalData"->>'youtubeVideoId' = $1 AND "deletedAt" IS NULL
        ORDER BY "createdAt" DESC
        LIMIT 1
      `;
      
      const result = await client.query(query, [youtubeVideoId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        logger.info(`Found existing episode by youtubeVideoId: ${row.episodeId} - "${row.episodeTitle}"`);
        
        const episode = {
          episodeId: row.episodeId,
          episodeTitle: row.episodeTitle,
          channelId: row.channelId,
          channelName: row.channelName,
          originalUri: row.originalUri,
          createdAt: row.createdAt,
          additionalData: row.additionalData || {},
        } as EpisodeRecord;
        
        this.releaseClient(client);
        return episode;
      }
      
      this.releaseClient(client);
      return null;
    } catch (error: any) {
      if (client) {
        this.releaseClient(client);
      }
      logger.error('Error checking episode existence by youtubeVideoId:', error as Error);
      throw error;
    }
  }

  /**
   * Get guest by name from the database
   */
  async getGuestByName(guestName: string): Promise<GuestRecord | null> {
    let client: Client | PoolClient | null = null;
    try {
      client = await this.getClient();
      // Only select guestName, guestDescription, guestImage, guestLanguage (guestId is not needed for lookup)
      const query = `
        SELECT "guestName", "guestDescription", "guestImage", "guestLanguage"
        FROM public."Guests"
        WHERE "guestName" = $1
      `;
      const result = await client.query(query, [guestName]);
      
      if (result.rows.length === 0) {
        this.releaseClient(client);
        return null;
      }
      
      const row = result.rows[0];
      logger.info(`Guest found: ${JSON.stringify(row)}`);
      const guest = {
        guestName: row.guestName,
        guestDescription: row.guestDescription,
        guestImage: row.guestImage,
        guestLanguage: row.guestLanguage || 'en',
      };
      
      this.releaseClient(client);
      return guest;
    } catch (error: any) {
      if (client) {
        this.releaseClient(client);
      }
      logger.error('Error fetching guest by name:', error as Error);
      return null;
    }
  }
  
  /**
   * Execute a database operation with automatic retry on deadlock
   */
  private async executeWithRetry<T>(
    operation: (client: Client | PoolClient) => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 100
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let client: Client | PoolClient | null = null;
      try {
        client = await this.getClient();
        const result = await operation(client);
        this.releaseClient(client);
        return result;
      } catch (error: any) {
        if (client) {
          this.releaseClient(client);
        }
        lastError = error;
        
        // Check if this is a retryable error (deadlock, serialization failure, etc.)
        const isRetryable = error.code === '40001' || // serialization_failure
                           error.code === '40P01' || // deadlock_detected
                           error.code === '55P03';   // lock_not_available
        
        if (!isRetryable || attempt === maxRetries) {
          throw error;
        }
        
        // Exponential backoff with jitter
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
        logger.warn(`Database operation failed (attempt ${attempt}/${maxRetries}), retrying in ${delay.toFixed(0)}ms...`, {
          error: error.message,
          code: error.code,
          attempt,
          maxRetries
        });
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }

  /**
   * Store new episode data from SQS message with automatic retry on conflicts
   */
  async storeNewEpisodeWithRetry(
    messageBody: SQSMessageBody,
    s3AudioLink: string,
    metadata?: VideoMetadata,
    thumbnailUrl?: string
  ): Promise<{ episodeId: string }> {
    return withSemaphore(dbSemaphore, 'db_write', () => this.executeWithRetry(async (client) => {
      return this.storeNewEpisodeInternal(client, messageBody, s3AudioLink, metadata, thumbnailUrl);
    }));
  }

  /**
   * Internal implementation of store new episode (for use within transactions)
   */
  private async storeNewEpisodeInternal(
    client: Client | PoolClient,
    messageBody: SQSMessageBody,
    s3AudioLink: string,
    metadata?: VideoMetadata,
    thumbnailUrl?: string
  ): Promise<{ episodeId: string }> {
    // Start transaction with appropriate isolation level
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    
    try {
      // Check for duplicate episodes first (within transaction)
      // 1. Check by episode title and channel
      const existingEpisodeByTitle = await this.checkEpisodeExistsInTransaction(
        client, 
        messageBody.episodeTitle, 
        messageBody.channelId
      );
      
      if (existingEpisodeByTitle) {
        await client.query('ROLLBACK');
        logger.warn(`⚠️ Episode already exists by title: "${messageBody.episodeTitle}" for channel: ${messageBody.channelId}`);
        logger.warn(`Existing episode ID: ${existingEpisodeByTitle.episodeId}, created: ${existingEpisodeByTitle.createdAt}`);
        throw new Error(`Duplicate episode detected: "${messageBody.episodeTitle}" already exists for this channel`);
      }
      
      // 2. Check by youtubeVideoId if available
      const youtubeVideoId = messageBody.additionalData?.youtubeVideoId;
      if (youtubeVideoId) {
        const existingEpisodeByVideoId = await this.checkEpisodeExistsByYoutubeVideoIdInTransaction(
          client,
          youtubeVideoId
        );
        
        if (existingEpisodeByVideoId) {
          await client.query('ROLLBACK');
          logger.warn(`⚠️ Episode already exists by youtubeVideoId: ${youtubeVideoId}`);
          logger.warn(`Existing episode ID: ${existingEpisodeByVideoId.episodeId}, title: "${existingEpisodeByVideoId.episodeTitle}"`);
          throw new Error(`Duplicate episode detected: youtubeVideoId "${youtubeVideoId}" already exists`);
        }
      }
      
      // Generate episode ID if not provided
      const episodeId = uuidv4();
      
      // Prepare episode data matching the actual database schema
      const episodeData: Partial<EpisodeRecord> = {
        episodeId,
        episodeTitle: sanitizeText(messageBody.episodeTitle),
        episodeDescription: sanitizeText(metadata?.description || ''),
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
        contentType: 'video',
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
        JSON.stringify(episodeData.guestImageUrl || []),     // $9 (JSON string)
        episodeData.publishedDate ? new Date(episodeData.publishedDate) 
                                  : null,                   // $10 (timestamp)
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
      
      const result = await client.query(query, values);
      
      if (result.rowCount !== 1) {
        throw new Error(`Failed to insert episode: expected 1 row affected, got ${result.rowCount}`);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      
      logger.info(`Episode stored successfully: ${episodeId}`);
      return { episodeId };
      
    } catch (error) {
      // Rollback transaction on any error
      await client.query('ROLLBACK');
      logger.error(`Failed to store episode:`, error as Error);
      throw error;
    }
  }

  /**
   * Store new episode data from SQS message with ACID compliance
   */
  async storeNewEpisode(
    messageBody: SQSMessageBody,
    s3AudioLink: string,
    metadata?: VideoMetadata,
    thumbnailUrl?: string
  ): Promise<{ episodeId: string }> {
    return this.storeNewEpisodeWithRetry(messageBody, s3AudioLink, metadata, thumbnailUrl);
  }

  /**
   * Helper method to check episode existence within a transaction
   */
  private async checkEpisodeExistsInTransaction(
    client: Client | PoolClient, 
    episodeTitle: string, 
    channelId: string
  ): Promise<EpisodeRecord | null> {
    const query = `
      SELECT "episodeId", "episodeTitle", "channelId", "channelName", "originalUri", "createdAt", "additionalData"
      FROM public."Episodes"
      WHERE "episodeTitle" = $1 AND "channelId" = $2 AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE NOWAIT
    `;
    
    try {
      const result = await client.query(query, [sanitizeText(episodeTitle), channelId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          episodeId: row.episodeId,
          episodeTitle: row.episodeTitle,
          channelId: row.channelId,
          channelName: row.channelName,
          originalUri: row.originalUri,
          createdAt: row.createdAt,
          additionalData: row.additionalData || {},
        } as EpisodeRecord;
      }
      
      return null;
    } catch (error: any) {
      if (error.code === '55P03') { // lock_not_available
        throw new Error('Another process is currently creating an episode with the same title. Please retry.');
      }
      throw error;
    }
  }

  /**
   * Helper method to check episode existence by youtubeVideoId within a transaction
   */
  private async checkEpisodeExistsByYoutubeVideoIdInTransaction(
    client: Client | PoolClient,
    youtubeVideoId: string
  ): Promise<EpisodeRecord | null> {
    const query = `
      SELECT "episodeId", "episodeTitle", "channelId", "channelName", "originalUri", "createdAt", "additionalData"
      FROM public."Episodes"
      WHERE "additionalData"->>'youtubeVideoId' = $1 AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE NOWAIT
    `;
    
    try {
      const result = await client.query(query, [youtubeVideoId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          episodeId: row.episodeId,
          episodeTitle: row.episodeTitle,
          channelId: row.channelId,
          channelName: row.channelName,
          originalUri: row.originalUri,
          createdAt: row.createdAt,
          additionalData: row.additionalData || {},
        } as EpisodeRecord;
      }
      
      return null;
    } catch (error: any) {
      if (error.code === '55P03') { // lock_not_available
        throw new Error('Another process is currently creating an episode with the same youtubeVideoId. Please retry.');
      }
      throw error;
    }
  }

  /**
   * Get episode by ID
   */
  async getEpisode(episodeId: string): Promise<EpisodeRecord | null> {
    let client: Client | PoolClient | null = null;
    
    try {
      client = await this.getClient();
      logger.info(`Fetching episode: ${episodeId}`);

      const query = `
        SELECT 
          "episodeId", "episodeTitle", "episodeDescription", "episodeImages", "episodeUri",
          "originalUri", "channelId", "channelName", "publishedDate", "createdAt", "updatedAt",
          "guestImageUrl", "additionalData", "guests", "guestDescriptions", "topics",
          "contentType", "country", "genre", "durationMillis", "rssUrl", "processingDone", "isSynced",
          "transcriptUri", "processedTranscriptUri", "summaryAudioUri", "summaryDurationMillis", "summaryTranscriptUri",
          "hostName", "hostDescription"
        FROM public."Episodes"
        WHERE "episodeId" = $1
      `;
      const result = await client.query(query, [episodeId]);
      
      if (result.rows.length === 0) {
        logger.info(`Episode not found: ${episodeId}`);
        this.releaseClient(client);
        return null;
      }
      
      const row = result.rows[0];
      
      // Parse guestImageUrl from JSON string to array
      let guestImageUrl: string[] = [];
      if (row.guestImageUrl) {
        try {
          guestImageUrl = typeof row.guestImageUrl === 'string' 
            ? JSON.parse(row.guestImageUrl) 
            : row.guestImageUrl;
        } catch (error) {
          logger.warn(`Failed to parse guestImageUrl for episode ${episodeId}:`, error as Error);
          guestImageUrl = [];
        }
      }
      
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
        hostName: row.hostName,
        hostDescription: row.hostDescription,
        guestImageUrl: guestImageUrl,
        guests: Array.isArray(row.guests) ? row.guests : (row.guests ? [row.guests] : []),
        guestDescriptions: Array.isArray(row.guestDescriptions) ? row.guestDescriptions : (row.guestDescriptions ? [row.guestDescriptions] : []),
        topics: Array.isArray(row.topics) ? row.topics : (row.topics ? [row.topics] : []),
        additionalData: row.additionalData || {},
        contentType: row.contentType,
        country: row.country,
        genre: row.genre,
        durationMillis: row.durationMillis,
        rssUrl: row.rssUrl,
        processingDone: row.processingDone,
        isSynced: row.isSynced,
        transcriptUri: row.transcriptUri,
        processedTranscriptUri: row.processedTranscriptUri,
        summaryAudioUri: row.summaryAudioUri,
        summaryDurationMillis: row.summaryDurationMillis,
        summaryTranscriptUri: row.summaryTranscriptUri,
      };
      
      logger.info(`Episode fetched successfully: ${episodeId}`);
      this.releaseClient(client);
      return episode as EpisodeRecord;
    } catch (error: any) {
      if (client) {
        this.releaseClient(client);
      }
      logger.error(`Failed to fetch episode ${episodeId}:`, error as Error);
      throw error;
    }
  }

  /**
   * Update episode data with proper transaction handling
   */
  async updateEpisode(episodeId: string, updateData: Partial<EpisodeRecord>): Promise<void> {
    const maxValidateRetries = parseInt(process.env.RDS_UPDATE_VALIDATE_RETRIES || '3', 10);
    const baseDelayMs = parseInt(process.env.RDS_UPDATE_VALIDATE_BASE_DELAY_MS || '200', 10);

    return withSemaphore(dbSemaphore, 'db_write', async () => {
      let attempt = 0;
      let lastError: any;
      while (attempt < maxValidateRetries) {
        attempt++;
        try {
          // Perform the update within its own transaction (READ COMMITTED)
          await this.executeWithRetry(async (client) => {
            return this.updateEpisodeInternal(client, episodeId, updateData);
          });

          // Independently validate in a separate query context
          const validationOk = await this.validateEpisodeUpdate(episodeId, updateData);
          if (validationOk) {
            return; // success
          }

          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn(`RDS update validation failed for episode ${episodeId} (attempt ${attempt}/${maxValidateRetries}). Retrying in ${delay}ms...`);
          await new Promise((res) => setTimeout(res, delay));
        } catch (err) {
          lastError = err;
          if (attempt >= maxValidateRetries) break;
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn(`RDS update attempt ${attempt} failed for episode ${episodeId}. Retrying in ${delay}ms...`, {
            error: (err as any)?.message || String(err)
          });
          await new Promise((res) => setTimeout(res, delay));
        }
      }
      // If we reached here, validation still failed or repeated errors occurred
      throw lastError || new Error(`RDS update validation failed after ${maxValidateRetries} attempts for episode ${episodeId}`);
    });
  }

  /**
   * Internal implementation of update episode (for use within transactions)
   */
  private async updateEpisodeInternal(
    client: Client | PoolClient,
    episodeId: string,
    updateData: Partial<EpisodeRecord>
  ): Promise<void> {
    logger.info(`Updating episode: ${episodeId} with data: ${JSON.stringify(updateData, null, 2)}`);
    
    // Start transaction with appropriate isolation level
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    
    try {
      logger.info(`RDS client is available: ${!!client}`);
      
      // First check if episode exists and lock it
      const episodeExistsQuery = `
        SELECT "episodeId", "additionalData" 
        FROM public."Episodes" 
        WHERE "episodeId" = $1 AND "deletedAt" IS NULL
        FOR UPDATE NOWAIT
      `;
      
      const existsResult = await client.query(episodeExistsQuery, [episodeId]);
      
      if (existsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Episode not found or deleted: ${episodeId}`);
      }
      
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      
      // Handle basic fields
      if (updateData.episodeTitle !== undefined) {
        updateFields.push(`"episodeTitle" = $${paramIndex++}`);
        values.push(sanitizeText(updateData.episodeTitle));
      }
      if (updateData.episodeDescription !== undefined) {
        updateFields.push(`"episodeDescription" = $${paramIndex++}`);
        values.push(sanitizeText(updateData.episodeDescription));
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
        logger.info(`Storing guests:`, {
          value: updateData.guests,
          type: typeof updateData.guests,
          isArray: Array.isArray(updateData.guests),
          length: updateData.guests?.length
        });
      }
      if (updateData.guestDescriptions !== undefined) {
        updateFields.push(`"guestDescriptions" = $${paramIndex++}`);
        values.push(updateData.guestDescriptions);
        logger.info(`Storing guestDescriptions:`, {
          value: updateData.guestDescriptions,
          type: typeof updateData.guestDescriptions,
          isArray: Array.isArray(updateData.guestDescriptions),
          length: updateData.guestDescriptions?.length,
          sample: updateData.guestDescriptions?.slice(0, 2)
        });
      }
      if (updateData.guestImageUrl !== undefined) {
        updateFields.push(`"guestImageUrl" = $${paramIndex++}`);
        values.push(JSON.stringify(updateData.guestImageUrl));
        logger.info(`Storing guestImageUrl:`, {
          value: updateData.guestImageUrl,
          type: typeof updateData.guestImageUrl,
          isArray: Array.isArray(updateData.guestImageUrl),
          length: updateData.guestImageUrl?.length,
          jsonString: JSON.stringify(updateData.guestImageUrl)
        });
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
        const existingAdditionalData = existsResult.rows[0].additionalData || {};
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
        await client.query('ROLLBACK');
        logger.info(`No fields to update for episode: ${episodeId}`);
        return;
      }
      
      values.push(episodeId);
      const query = `
        UPDATE public."Episodes" 
        SET ${updateFields.join(', ')}
        WHERE "episodeId" = $${paramIndex} AND "deletedAt" IS NULL
      `;
      
      const result = await client.query(query, values);
      
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Episode not found or deleted: ${episodeId}`);
      } else if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new Error(`Unexpected update result: expected 1 row affected, got ${result.rowCount}`);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      logger.info(`Episode updated successfully: ${episodeId}`);
      
    } catch (error: any) {
      // Rollback transaction on any error
      await client.query('ROLLBACK');
      if (error.code === '55P03') { // lock_not_available
        logger.error(`Episode ${episodeId} is being updated by another process. Please retry.`);
        throw new Error(`Episode ${episodeId} is currently being updated by another process. Please retry.`);
      }
      logger.error(`Failed to update episode ${episodeId}:`, error as Error);
      throw error;
    }
  }
  
  /**
   * Update episode with guest extraction results using transaction
   */
  async updateEpisodeWithGuestExtraction(episodeId: string, extractionResult: GuestExtractionResult): Promise<void> {
    return withSemaphore(dbSemaphore, 'db_write', () => this.executeWithRetry(async (client) => {
      return this.updateEpisodeWithGuestExtractionInternal(client, episodeId, extractionResult);
    }));
  }

  /**
   * Internal implementation of update episode with guest extraction (for use within transactions)
   */
  private async updateEpisodeWithGuestExtractionInternal(
    client: Client | PoolClient,
    episodeId: string,
    extractionResult: GuestExtractionResult
  ): Promise<void> {
  // Start transaction with the lowest effective isolation level in PostgreSQL.
  // Note: PostgreSQL treats READ UNCOMMITTED as READ COMMITTED, so we explicitly use READ COMMITTED.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    
    try {
      logger.info(`Updating episode ${episodeId} with guest extraction results: ${JSON.stringify(extractionResult, null, 2)}`);
      
      // First verify episode exists and lock it
      const episodeExistsQuery = `
        SELECT "episodeId", "additionalData" 
        FROM public."Episodes" 
        WHERE "episodeId" = $1 AND "deletedAt" IS NULL
        FOR UPDATE NOWAIT
      `;
      
      const existsResult = await client.query(episodeExistsQuery, [episodeId]);
      
      if (existsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Episode not found or deleted: ${episodeId}`);
      }
      
      // Prepare guest data for RDS
      const guestNames: string[] = extractionResult.guest_names;
      const guestDescriptions: string[] = guestNames.map(name => {
        const guestDetail = extractionResult.guest_details[name];
        return guestDetail?.guestDescription || 'No description available';
      });

      // Prepare guest images data - ensure array alignment with guest names
      const guestImageUrl: string[] = guestNames.map(name => {
        const guestDetail = extractionResult.guest_details[name];
        if (guestDetail?.guestImage) {
          const imageUrl = guestDetail.guestImage?.s3Url || guestDetail.guestImage;
          return typeof imageUrl === 'string' ? imageUrl : '';
        }
        return '';
      }).filter(url => url !== ''); 

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

      // Merge additional data with existing
      const existingAdditionalData = existsResult.rows[0].additionalData || {};
      const mergedAdditionalData = {
        ...existingAdditionalData,
        guestEnrichmentMetadata: enrichmentMetadata,
        extractedDescription: extractionResult.description
      };

      // Log the arrays being stored for debugging
      logger.info(`Storing guest data:`, {
        guests: guestNames,
        guestDescriptions: guestDescriptions,
        guestImageUrl: guestImageUrl,
        guestImageUrlType: Array.isArray(guestImageUrl) ? 'array' : typeof guestImageUrl,
        guestImageUrlLength: guestImageUrl.length,
        guestDescriptionsType: Array.isArray(guestDescriptions) ? 'array' : typeof guestDescriptions,
        guestDescriptionsLength: guestDescriptions.length
      });

      // Update the episode with all guest data
      const updateQuery = `
        UPDATE public."Episodes" 
        SET 
          "guests" = $1,
          "guestDescriptions" = $2,
          "guestImageUrl" = $3,
          "topics" = $4,
          "additionalData" = $5,
          "updatedAt" = $6
        WHERE "episodeId" = $7 AND "deletedAt" IS NULL
      `;
      
      const updateValues = [
        guestNames,                           // $1 (text[])
        guestDescriptions,                    // $2 (text[])
        JSON.stringify(guestImageUrl),        // $3 (JSON string)
        extractionResult.topics,              // $4 (text[])
        JSON.stringify(mergedAdditionalData), // $5 (jsonb)
        new Date().toISOString(),             // $6 (timestamp)
        episodeId                             // $7
      ];
      
      const updateResult = await client.query(updateQuery, updateValues);
      
      if (updateResult.rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new Error(`Failed to update episode ${episodeId}: expected 1 row affected, got ${updateResult.rowCount}`);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      
      logger.info(`Updated episode ${episodeId} with ${guestNames.length} guests, ${extractionResult.topics.length} topics, and ${guestImageUrl.length} guest images`);
      
      // Independently validate in a separate query context; retry on mismatch with exponential backoff
  const maxValidateRetries = parseInt(process.env.RDS_UPDATE_VALIDATE_RETRIES || '3', 10);
      const baseDelayMs = parseInt(process.env.RDS_UPDATE_VALIDATE_BASE_DELAY_MS || '200', 10);
      for (let attempt = 1; attempt <= maxValidateRetries; attempt++) {
        const expected: Partial<EpisodeRecord> = {
          guests: guestNames,
          guestDescriptions: guestDescriptions,
          topics: extractionResult.topics,
          // additionalData should contain at least the keys we added/updated
          additionalData: {
    // Use an object to assert presence; validator checks for presence/type when value is object
    guestEnrichmentMetadata: {},
    extractedDescription: extractionResult.description
          } as any
        } as any;

        const ok = await this.validateEpisodeUpdate(episodeId, expected);
        if (ok) break;
        if (attempt === maxValidateRetries) {
          throw new Error(`RDS validation failed after updating guest extraction fields for episode ${episodeId}`);
        }
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`RDS guest extraction update validation failed (attempt ${attempt}/${maxValidateRetries}) for ${episodeId}. Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
      }
      
    } catch (error: any) {
      // Rollback transaction on any error
      await client.query('ROLLBACK');
      if (error.code === '55P03') { // lock_not_available
        logger.error(`Episode ${episodeId} is being updated by another process during guest extraction. Please retry.`);
        throw new Error(`Episode ${episodeId} is currently being updated by another process. Please retry guest extraction.`);
      }
      logger.error(`Failed to update episode ${episodeId} with guest extraction results:`, error as Error);
      throw error;
    }
  }

  /**
   * Insert a new guest record into the database with transaction handling
   */
  async insertGuest(guest: GuestRecord): Promise<void> {
    return withSemaphore(dbSemaphore, 'db_write', () => this.executeWithRetry(async (client) => {
      return this.insertGuestInternal(client, guest);
    }));
  }

  /**
   * Internal implementation of insert guest (for use within transactions)
   */
  private async insertGuestInternal(client: Client | PoolClient, guest: GuestRecord): Promise<void> {
    // Start transaction
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    
    try {
      // Check if guest already exists
      const existsQuery = `
        SELECT "guestId" 
        FROM public."Guests" 
        WHERE "guestName" = $1
        FOR UPDATE NOWAIT
      `;
      
      const existsResult = await client.query(existsQuery, [guest.guestName]);
      
      if (existsResult.rows.length > 0) {
        // Update existing guest
        const updateQuery = `
          UPDATE public."Guests" 
          SET 
            "guestDescription" = $1,
            "guestImage" = $2,
            "guestLanguage" = $3
          WHERE "guestName" = $4
        `;
        
        await client.query(updateQuery, [
          guest.guestDescription,
          guest.guestImage,
          guest.guestLanguage,
          guest.guestName
        ]);
        
        logger.info(`Guest updated: ${guest.guestName}`);
      } else {
        // Insert new guest
        const insertQuery = `
          INSERT INTO public."Guests" (
            "guestId", "guestName", "guestDescription", "guestImage", "guestLanguage"
          ) VALUES ($1, $2, $3, $4, $5)
        `;
        
        await client.query(insertQuery, [
          guest.guestId || uuidv4(),  
          guest.guestName,
          guest.guestDescription,
          guest.guestImage,
          guest.guestLanguage
        ]);
        
        logger.info(`Guest inserted: ${guest.guestName}`);
      }
      
      // Commit transaction
      await client.query('COMMIT');
      
    } catch (error: any) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      if (error.code === '55P03') { // lock_not_available
        logger.error(`Guest ${guest.guestName} is being modified by another process. Please retry.`);
        throw new Error(`Guest ${guest.guestName} is currently being modified by another process. Please retry.`);
      }
      logger.error('Error inserting/updating guest:', error as Error);
      throw error;
    }
  }

  /**
   * Delete a guest record from the database by name with transaction handling
   */
  async deleteGuestByName(guestName: string): Promise<boolean> {
    return withSemaphore(dbSemaphore, 'db_write', () => this.executeWithRetry(async (client) => {
      return this.deleteGuestByNameInternal(client, guestName);
    }));
  }

  /**
   * Internal implementation of delete guest by name (for use within transactions)
   */
  private async deleteGuestByNameInternal(client: Client | PoolClient, guestName: string): Promise<boolean> {
    // Start transaction
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    
    try {
      // First check if guest exists and lock it
      const existsQuery = `
        SELECT "guestId" 
        FROM public."Guests" 
        WHERE "guestName" = $1
        FOR UPDATE NOWAIT
      `;
      
      const existsResult = await client.query(existsQuery, [guestName]);
      
      if (existsResult.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.info(`No guest found to delete: ${guestName}`);
        return false;
      }
      
      // Delete the guest
      const deleteQuery = `
        DELETE FROM public."Guests"
        WHERE "guestName" = $1
      `;
      
      const result = await client.query(deleteQuery, [guestName]);
      
      if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new Error(`Unexpected delete result: expected 1 row affected, got ${result.rowCount}`);
      }
      
      // Commit transaction
      await client.query('COMMIT');
      
      logger.info(`Guest deleted: ${guestName}`);
      return true;
      
    } catch (error: any) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      if (error.code === '55P03') { // lock_not_available
        logger.error(`Guest ${guestName} is being modified by another process. Please retry.`);
        throw new Error(`Guest ${guestName} is currently being modified by another process. Please retry.`);
      }
      logger.error('Error deleting guest:', error as Error);
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

}

/**
 * Create RDS service instance from environment variables with optional connection pooling
 */
export function createRDSServiceFromEnv(usePool: boolean = false): RDSService | null {
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
    // Connection pool settings
    max: parseInt(process.env.RDS_POOL_MAX || '20'),
    idleTimeoutMillis: parseInt(process.env.RDS_IDLE_TIMEOUT || '30000'),
    connectionTimeoutMillis: parseInt(process.env.RDS_CONNECTION_TIMEOUT || '2000'),
  };

  const service = new RDSService(config, undefined, usePool);
  
  // Initialize pool if requested
  if (usePool) {
    service.initPool().catch(error => {
      logger.error('Failed to initialize connection pool:', error);
    });
  }

  return service;
}

/**
 * Sanitize text for PostgreSQL storage by normalizing the string,
 * removing control characters, and collapsing whitespace.
 */
function sanitizeText(text: string): string {
  if (!text) {
    return '';
  }

  // 1. Normalize to NFC for a consistent Unicode representation. This is a
  // best practice for storing text to avoid issues with characters that
  // can be represented in multiple ways.
  const normalized = text.normalize('NFC');

  // 2. Replace all Unicode control characters (\p{C}), including the null
  // byte (\u0000) that PostgreSQL specifically forbids, with a space.
  // The 'u' flag is required for Unicode property escapes like \p{C}.
  const replaced = normalized.replace(/\p{C}/gu, ' ');

  // 3. Collapse consecutive whitespace characters into a single space
  // and trim any leading or trailing whitespace.
  return replaced.replace(/\s+/g, ' ').trim();
}

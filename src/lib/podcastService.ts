/**
 * Podcast Service
 * 
 * Service for managing podcast episodes, processing metadata, and interacting with storage.
 * This service provides a higher-level API for podcast-related operations.
 */

import { DynamoDBService } from './dynamoService.js';
import { VideoMetadata, PodcastEpisodeData } from '../types.js';
import logger from './logger.js';

export interface PodcastServiceConfig {
  region: string;
  episodeTableName?: string;
  podcastRSSLinkTableName?: string;
}

export class PodcastService {
  private dynamoService: DynamoDBService;

  constructor(config: PodcastServiceConfig) {
    this.dynamoService = new DynamoDBService({
      region: config.region,
      metadataTableName: 'PodcastEpisodeStoreTest',
      podcastEpisodesTableName: config.episodeTableName
    });
  }

  /**
   * Initialize service and ensure required tables exist
   */
  async ensureEpisodeTableExists(): Promise<void> {
    return this.dynamoService.ensureTablesExist();
  }

  /**
   * Process video metadata into podcast episode data
   * 
   * @param videoMetadata - Metadata from video source
   * @param audioS3Link - S3 URL for the audio file (optional for tests)
   * @returns Processed podcast episode data
   */
  async processEpisodeMetadata(
    videoMetadata: VideoMetadata,
    audioS3Link: string = ''
  ): Promise<PodcastEpisodeData> {
    logger.info('Processing episode metadata in PodcastService');
    return this.dynamoService.processEpisodeMetadata(videoMetadata, audioS3Link);
  }

  /**
   * Save podcast episode to database
   * 
   * @param episode - Episode data to save
   * @returns Promise<boolean> - Success status
   */
  async insertEpisode(episode: PodcastEpisodeData): Promise<boolean> {
    return this.dynamoService.savePodcastEpisode(episode);
  }

  /**
   * Get podcast episode by ID
   * 
   * @param episodeId - Episode ID
   * @returns Episode data or null if not found
   */
  async getEpisode(episodeId: string): Promise<PodcastEpisodeData | null> {
    return this.dynamoService.getPodcastEpisode(episodeId);
  }

  /**
   * Get episodes by podcast title
   * 
   * @param podcastTitle - Podcast title to search for
   * @param limit - Maximum number of episodes to return
   * @returns Array of episode data
   */
  async getEpisodesByTitle(podcastTitle: string, limit: number = 50): Promise<PodcastEpisodeData[]> {
    return this.dynamoService.getPodcastEpisodesByTitle(podcastTitle, limit);
  }

  /**
   * Update episode with video S3 link
   * 
   * @param episodeId - Episode ID to update
   * @param videoS3Link - S3 link for the video
   * @returns Success status
   */
  async updateEpisodeVideoLink(episodeId: string, videoS3Link: string): Promise<boolean> {
    return this.dynamoService.updateEpisodeVideoLink(episodeId, videoS3Link);
  }
}

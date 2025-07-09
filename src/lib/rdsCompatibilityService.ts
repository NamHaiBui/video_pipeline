import { RDSService, CreateEpisodeInput, UpdateEpisodeInput, EpisodeRecord } from './rdsService.js';
import { RDSEpisodeData, VideoMetadata, EpisodeProcessingInfo } from '../types.js';
import { logger } from './logger.js';

/**
 * Compatibility service that provides DynamoDB-like interface while using RDS underneath.
 * This allows gradual migration from DynamoDB to RDS without changing all calling code at once.
 */
export class RDSCompatibilityService {
  private rdsService: RDSService;

  constructor(rdsService: RDSService) {
    this.rdsService = rdsService;
  }

  /**
   * Save podcast episode - compatibility method for DynamoDB interface
   */
  async savePodcastEpisode(episode: PodcastEpisodeData): Promise<boolean> {
    try {
      // Convert old DynamoDB format to new RDS format
      const rdsEpisodeData: CreateEpisodeInput = this.convertPodcastEpisodeDataToRDS(episode);
      await this.rdsService.createEpisode(rdsEpisodeData);
      return true;
    } catch (error) {
      logger.error('Failed to save podcast episode:', error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Get podcast episode - compatibility method for DynamoDB interface
   */
  async getPodcastEpisode(episodeId: string): Promise<PodcastEpisodeData | null> {
    try {
      const episode = await this.rdsService.getEpisode(episodeId);
      if (!episode) return null;
      
      // Convert RDS format back to old DynamoDB format for compatibility
      return this.convertRDSEpisodeToPodcastEpisodeData(episode);
    } catch (error) {
      logger.error('Failed to get podcast episode:', error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Update podcast episode - compatibility method for DynamoDB interface
   */
  async updatePodcastEpisode(PK: string, SK: string, updateData: Partial<PodcastEpisodeData>): Promise<boolean> {
    try {
      // Extract episode ID from PK (format: EPISODE#episodeId)
      const episodeId = PK.replace('EPISODE#', '');
      
      // Convert update data to RDS format
      const rdsUpdateData: UpdateEpisodeInput = this.convertPodcastEpisodeUpdateToRDS(updateData);
      
      const result = await this.rdsService.updateEpisode(episodeId, rdsUpdateData);
      return result !== null;
    } catch (error) {
      logger.error('Failed to update podcast episode:', error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Process episode metadata - maintains compatibility with existing interface
   */
  processEpisodeMetadata(videoMetadata: VideoMetadata, audioS3Link: string, channelId?: string): PodcastEpisodeData {
    // Create RDS episode data first
    const rdsData = this.rdsService.processEpisodeMetadata(videoMetadata, audioS3Link, channelId);
    
    // Convert to old PodcastEpisodeData format for compatibility
    return this.convertRDSInputToPodcastEpisodeData(rdsData, videoMetadata);
  }

  /**
   * Convert old PodcastEpisodeData to new RDS format
   */
  private convertPodcastEpisodeDataToRDS(episode: PodcastEpisodeData): CreateEpisodeInput {
    const processingInfo: EpisodeProcessingInfo = {
      episodeTranscribingDone: episode.transcription_status === 'COMPLETED',
      summaryTranscribingDone: episode.summarization_status === 'COMPLETED',
      summarizingDone: episode.summarization_status === 'COMPLETED',
      numChunks: episode.num_chunks || 0,
      numRemovedChunks: episode.num_removed_chunks || 0,
      chunkingDone: episode.chunking_status === 'COMPLETED',
      quotingDone: episode.quote_status === 'COMPLETED'
    };

    return {
      episodeId: episode.id || episode.episode_id,
      episodeTitle: episode.episode_title_details || episode.episode_title,
      episodeDescription: episode.description || '',
      channelName: episode.podcast_title,
      publishedDate: new Date(episode.published_date),
      episodeUrl: episode.audio_url,
      originalUrl: episode.episode_url,
      channelId: episode.podcast_id || episode.podcast_title,
      country: episode.country,
      durationMillis: episode.episode_time_millis,
      rssUrl: episode.rss_url,
      transcriptUri: episode.transcript_uri,
      summaryDurationMillis: episode.summary_metadata?.summary_duration ? 
        parseInt(episode.summary_metadata.summary_duration.S) : undefined,
      topics: episode.topics?.map(t => t.S) || [],
      processingInfo,
      contentType: 'Audio',
      additionalData: {
        guest_count: episode.guest_count,
        personalities: episode.personalities?.map(p => p.S) || [],
        genres: episode.genres?.map(g => g.S) || [],
        videoFileName: episode.videoFileName
      },
      processingDone: processingInfo.chunkingDone && processingInfo.quotingDone,
      isSynced: false
    };
  }

  /**
   * Convert RDS episode back to old PodcastEpisodeData format
   */
  private convertRDSEpisodeToPodcastEpisodeData(episode: EpisodeRecord): PodcastEpisodeData {
    const processingInfo = typeof episode.processingInfo === 'string' ? 
      JSON.parse(episode.processingInfo) : episode.processingInfo;
    
    const additionalData = typeof episode.additionalData === 'string' ? 
      JSON.parse(episode.additionalData) : episode.additionalData;

    return {
      id: episode.episodeId,
      episode_id: episode.episodeId,
      podcast_title: episode.channelName,
      episode_title: episode.episodeTitle,
      episode_title_details: episode.episodeTitle,
      audio_chunking_status: processingInfo.chunkingDone ? 'COMPLETED' : 'PENDING',
      audio_url: episode.episodeUrl || '',
      chunking_status: processingInfo.chunkingDone ? 'COMPLETED' : 'PENDING',
      country: episode.country || '',
      description: episode.episodeDescription || '',
      episode_downloaded: true,
      episode_guid: episode.episodeId,
      episode_time_millis: episode.durationMillis,
      episode_url: episode.originalUrl,
      file_name: `${episode.channelName}/${episode.episodeTitle}.mp3`,
      genres: additionalData.genres?.map((g: string) => ({ S: g })) || [],
      guest_count: additionalData.guest_count || 0,
      guest_description: [],
      guest_extraction_confidence: '',
      guest_names: [],
      image: {
        artworkUrl600: { S: '' },
        artworkUrl60: { S: '' },
        artworkUrl160: { S: '' }
      },
      num_chunks: processingInfo.numChunks,
      num_quotes: 0,
      num_removed_chunks: processingInfo.numRemovedChunks,
      partial_data: false,
      personalities: additionalData.personalities?.map((p: string) => ({ S: p })) || [],
      podcast_author: episode.channelName,
      podcast_id: episode.channelId,
      published_date: episode.publishedDate.toISOString(),
      quote_status: processingInfo.quotingDone ? 'COMPLETED' : 'PENDING',
      quotes_audio_status: processingInfo.quotingDone ? 'COMPLETED' : 'PENDING',
      quotes_video_status: processingInfo.quotingDone ? 'COMPLETED' : 'PENDING',
      rss_url: episode.rssUrl || '',
      source: 'youtube',
      summarization_status: processingInfo.summarizingDone ? 'COMPLETED' : 'PENDING',
      summary_metadata: {
        topic_metadata: {
          M: {
            start: { L: [] },
            end: { L: [] },
            topics: { L: [] },
            chunk_nos: { L: [] }
          }
        },
        summary_transcript_file_name: { S: '' },
        summary_duration: { S: episode.summaryDurationMillis?.toString() || '0' }
      },
      topics: episode.topics?.map((t: string) => ({ S: t })) || [],
      transcript_uri: episode.transcriptUri || '',
      transcription_status: processingInfo.episodeTranscribingDone ? 'COMPLETED' : 'PENDING',
      video_chunking_status: processingInfo.chunkingDone ? 'COMPLETED' : 'PENDING',
      videoFileName: additionalData.videoFileName || '',
      // Add PK and SK for compatibility with DynamoDB queries
      PK: `EPISODE#${episode.episodeId}`,
      SK: `CHANNEL#${episode.channelId}#DATE#${episode.publishedDate.toISOString()}`,
      // Add missing fields with defaults
      uploader: episode.channelName,
      title: episode.episodeTitle
    } as PodcastEpisodeData;
  }

  /**
   * Convert RDS CreateEpisodeInput to old PodcastEpisodeData format
   */
  private convertRDSInputToPodcastEpisodeData(rdsData: CreateEpisodeInput, videoMetadata: VideoMetadata): PodcastEpisodeData {
    const processingInfo = rdsData.processingInfo || {
      episodeTranscribingDone: false,
      summaryTranscribingDone: false,
      summarizingDone: false,
      numChunks: 0,
      numRemovedChunks: 0,
      chunkingDone: false,
      quotingDone: false
    };

    return {
      id: rdsData.episodeId,
      episode_id: rdsData.episodeId,
      podcast_title: rdsData.channelName,
      episode_title: rdsData.episodeTitle,
      episode_title_details: rdsData.episodeTitle,
      audio_chunking_status: 'PENDING',
      audio_url: rdsData.episodeUrl || '',
      chunking_status: 'PENDING',
      country: rdsData.country || '',
      description: rdsData.episodeDescription,
      episode_downloaded: false,
      episode_guid: rdsData.episodeId,
      episode_time_millis: rdsData.durationMillis,
      episode_url: rdsData.originalUrl,
      file_name: `${rdsData.channelName}/${rdsData.episodeTitle}.mp3`,
      genres: [],
      guest_count: 0,
      guest_description: [],
      guest_extraction_confidence: '',
      guest_names: [],
      image: {
        artworkUrl600: { S: videoMetadata.thumbnail || '' },
        artworkUrl60: { S: videoMetadata.thumbnail || '' },
        artworkUrl160: { S: videoMetadata.thumbnail || '' }
      },
      num_chunks: processingInfo.numChunks,
      num_quotes: 0,
      num_removed_chunks: processingInfo.numRemovedChunks,
      partial_data: false,
      personalities: [],
      podcast_author: rdsData.channelName,
      podcast_id: rdsData.channelId,
      published_date: rdsData.publishedDate.toISOString(),
      quote_status: 'PENDING',
      quotes_audio_status: 'PENDING',
      quotes_video_status: 'PENDING',
      rss_url: rdsData.rssUrl || '',
      source: 'youtube',
      summarization_status: 'PENDING',
      summary_metadata: {
        topic_metadata: {
          M: {
            start: { L: [] },
            end: { L: [] },
            topics: { L: [] },
            chunk_nos: { L: [] }
          }
        },
        summary_transcript_file_name: { S: '' },
        summary_duration: { S: '0' }
      },
      topics: rdsData.topics?.map(t => ({ S: t })) || [],
      transcript_uri: rdsData.transcriptUri || '',
      transcription_status: 'PENDING',
      video_chunking_status: 'PENDING',
      videoFileName: ''
    } as PodcastEpisodeData;
  }

  /**
   * Convert partial PodcastEpisodeData update to RDS update format
   */
  private convertPodcastEpisodeUpdateToRDS(updateData: Partial<PodcastEpisodeData>): UpdateEpisodeInput {
    const rdsUpdate: UpdateEpisodeInput = {};

    // Map fields from old format to new format
    if (updateData.episode_title_details) rdsUpdate.episodeTitle = updateData.episode_title_details;
    if (updateData.description) rdsUpdate.episodeDescription = updateData.description;
    if (updateData.audio_url) rdsUpdate.episodeUrl = updateData.audio_url;
    if (updateData.transcript_uri) rdsUpdate.transcriptUri = updateData.transcript_uri;
    if (updateData.videoFileName) {
      rdsUpdate.additionalData = { videoFileName: updateData.videoFileName };
    }

    // Handle processing status updates
    const processingUpdates: Partial<EpisodeProcessingInfo> = {};
    if (updateData.transcription_status === 'COMPLETED') {
      processingUpdates.episodeTranscribingDone = true;
    }
    if (updateData.chunking_status === 'COMPLETED') {
      processingUpdates.chunkingDone = true;
    }
    if (updateData.summarization_status === 'COMPLETED') {
      processingUpdates.summarizingDone = true;
      processingUpdates.summaryTranscribingDone = true;
    }
    if (updateData.quote_status === 'COMPLETED') {
      processingUpdates.quotingDone = true;
    }
    if (updateData.num_chunks !== undefined) {
      processingUpdates.numChunks = updateData.num_chunks;
    }
    if (updateData.num_removed_chunks !== undefined) {
      processingUpdates.numRemovedChunks = updateData.num_removed_chunks;
    }

    if (Object.keys(processingUpdates).length > 0) {
      rdsUpdate.processingInfo = processingUpdates;
    }

    // Check if processing is complete
    const allStatusesComplete = [
      updateData.transcription_status,
      updateData.chunking_status,
      updateData.summarization_status,
      updateData.quote_status
    ].every(status => status === 'COMPLETED' || status === undefined);

    if (allStatusesComplete && Object.keys(processingUpdates).length > 0) {
      rdsUpdate.processingDone = true;
    }

    return rdsUpdate;
  }

  /**
   * Direct access to RDS service for new code
   */
  getRDSService(): RDSService {
    return this.rdsService;
  }
}

/**
 * Create RDS compatibility service from environment variables
 */
export function createRDSCompatibilityService(): RDSCompatibilityService {
  const rdsService = new RDSService({
    host: process.env.RDS_HOST || 'localhost',
    user: process.env.RDS_USER || 'postgres',
    password: process.env.RDS_PASSWORD || '',
    database: process.env.RDS_DATABASE || 'postgres',
    port: parseInt(process.env.RDS_PORT || '5432'),
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  return new RDSCompatibilityService(rdsService);
}

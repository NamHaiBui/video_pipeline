import { GuestExtractionResult } from './lib/guestExtractionService.js';

export interface VideoMetadata {
  title: string;
  uploader: string;
  id: string;
  duration: number;
  description: string;
  upload_date: string;
  view_count: number;
  like_count?: number;
  dislike_count?: number;
  average_rating?: number;
  age_limit: number;
  webpage_url: string;
  extractor: string;
  extractor_key: string;
  thumbnail: string;
  thumbnails: Array<{
    url: string;
    id: string;
    width?: number;
    height?: number;
  }>;
  formats: Array<{
    format_id: string;
    url: string;
    ext: string;
    format: string;
    format_note?: string;
    width?: number;
    height?: number;
    fps?: number;
    acodec?: string;
    vcodec?: string;
    abr?: number;
    vbr?: number;
    filesize?: number;
    filesize_approx?: number;
  }>;
  [key: string]: any; 
}

export interface ProgressInfo {
  percent: string;
  eta: string;
  speed: string;
  total?: string;
  raw: string;
}

export interface DownloadOptions {
  outputDir?: string;
  outputFilename?: string;
  format?: string;
  onProgress?: (progress: ProgressInfo) => void;
  clientType?: string;
  cookiesFile?: string;
  poToken?: string;
  userAgent?: string;
  additionalHeaders?: string[];
  s3Upload?: {
    enabled: boolean;
    audioKeyPrefix?: string;
    videoKeyPrefix?: string;
    metadataKeyPrefix?: string;
    deleteLocalAfterUpload?: boolean;
  };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface DownloadJob {
  id: string;
  url: string;
  status: 'pending' | 'downloading_metadata' | 'extracting_guests' | 'downloading' | 'merging' | 'uploading' | 'completed' | 'error';
  progress: {
    video?: ProgressInfo;
    audio?: ProgressInfo;
    merged?: ProgressInfo;
  };
  metadata?: VideoMetadata;
  guestExtraction?: GuestExtractionResult;
  guestExtractionError?: string;
  filePaths?: {
    videoPath?: string;
    audioPath?: string;
    mergedPath?: string;
    metadataPath?: string;
  };
  s3Locations?: {
    video?: {
      bucket: string;
      key: string;
      location: string;
    };
    audio?: {
      bucket: string;
      key: string;
      location: string;
    };
    metadata?: {
      bucket: string;
      key: string;
      location: string;
    };
  };
  s3Error?: string;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface DownloadRequest {
  url: string;
}

export interface DownloadResponse {
  success: boolean;
  jobId: string;
  message: string;
}

export interface JobStatusResponse {
  success: boolean;
  job?: DownloadJob;
  message: string;
}

export interface SQSJobMessage {
  // Video Enrichment format: {"id": str, "url": str}
  id?: string; // Episode ID for video enrichment jobs
  url?: string; // Video URL for video enrichment jobs or legacy format
  
  // New Entry format: comprehensive video metadata
  videoId?: string;
  episodeTitle?: string;
  channelName?: string;
  channelId?: string;
  originalUri?: string; // The video URL for new entries
  publishedDate?: string;
  contentType?: 'Video';
  hostName?: string;
  hostDescription?: string;
  languageCode?: string;
  genre?: string;
  country?: string;
  websiteLink?: string;
  additionalData?: {
    youtubeVideoId?: string;
    youtubeChannelId?: string;
    youtubeUrl?: string;
    triggeredManually?: string;
    notificationReceived?: string;
    [key: string]: any;
  };
  
  // Legacy format fields (for backward compatibility)
  jobId?: string; // Job ID for legacy downloads (auto-generated if not provided)
  
  options?: {
    format?: string;
    quality?: string;
    extractAudio?: boolean;
    priority?: 'high' | 'normal' | 'low';
  };
  metadata?: Record<string, any>;
  
  // Legacy channelInfo - for backward compatibility (deprecated)
  channelInfo?: {
    channelId: string;
    channelName: string;
    hostName?: string;
    hostDescription?: string;
    country?: string;
    genre?: string; // genreId will be passed as 'genre' in SQS message
    rssUrl?: string;
    guests?: string[];
    guestDescriptions?: string[];
    guestImageUrl?: string;
    episodeImages?: string[];
    topics?: string[];
    channelDescription?: string;
    channelThumbnail?: string;
    subscriberCount?: number;
    verified?: boolean;
    notificationReceived?: string;
    [key: string]: any;
  };
}

export interface SQSResponseMessage {
  success: boolean;
  jobId: string;
  message: string;
  timestamp: string;
}

/**
 * Analysis result from AI content analysis
 */
export interface ContentAnalysisResult {
  /** Number of personalities found */
  number_of_personalities?: number;
  /** List of personality names */
  personalities: string[];
  /** Whether topics match */
  topic_match?: boolean;
  /** List of matching topics */
  matching_topics: string[];
}

/**
 * Configuration for content analysis
 */
export interface AnalysisConfig {
  /** List of topic keywords to match against */
  topic_keywords?: string[];
  /** List of person keywords to match against */
  person_keywords?: string[];
  /** Enable AI analysis */
  enable_ai_analysis?: boolean;
}

/**
 * Processing information for episodes matching the new RDS schema
 */
export interface EpisodeProcessingInfo {
  episodeTranscribingDone: boolean;
  summaryTranscribingDone: boolean;
  summarizingDone: boolean;
  numChunks: number;
  numRemovedChunks: number;
  chunkingDone: boolean;
  quotingDone: boolean;
}

/**
 * Episode data structure matching the exact RDS table schema
 */
export interface RDSEpisodeData {
  /** Unique episode identifier (Primary Key) */
  episodeId: string;
  /** Title of the episode */
  episodeTitle: string;
  /** Description/summary of the episode */
  episodeDescription: string;
  /** S3 URL for the episode thumbnail image */
  episodeThumbnailImageUrl?: string;
  /** S3 URL for the episode (audio/video file) */
  episodeUrl?: string;
  /** Original URL from the source site */
  originalUrl: string;
  /** Duration in milliseconds */
  durationMillis: number;
  /** When the episode was published */
  publishedDate: Date;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
  /** Soft delete timestamp (null when not deleted) */
  deletedAt?: Date;
  
  /** Channel identifier */
  channelId: string;
  /** Name of the channel/podcast */
  channelName: string;
  /** RSS feed URL */
  rssUrl?: string;
  /** Channel thumbnail URL */
  channelThumbnailUrl?: string;
  
  /** Name of the host */
  hostName?: string;
  /** Description of the host */
  hostDescription?: string;
  /** S3 URL for host image */
  hostImageUrl?: string;
  
  /** Array of guest names (as JSON) */
  guests?: string[];
  /** Array of guest descriptions (as JSON) */
  guestDescriptions?: string[];
  /** S3 URL for guest images (as JSON) */
  guestImages?: string[];
  
  /** Array of topics/tags (as JSON) */
  topics?: string[];
  /** Summary metadata as JSON */
  summaryMetadata?: Record<string, any>;
  
  /** Country of origin */
  country?: string;
  /** Genre/category of the episode */
  genre?: string;
  /** Language code */
  languageCode?: string;
  
  /** S3 URL for transcript */
  transcriptUri?: string;
  /** S3 URL for processed transcript */
  processedTranscriptUri?: string;
  /** S3 URL for summary audio */
  summaryAudioUri?: string;
  /** Duration of summary in milliseconds */
  summaryDurationMillis?: number;
  /** S3 URL for summary transcript */
  summaryTranscriptUri?: string;
  
  /** Content type: Audio or Video */
  contentType: 'Audio' | 'Video';
  /** Processing status information (as JSON) */
  processingInfo: EpisodeProcessingInfo;
  /** Additional data as JSON for future use */
  additionalData: Record<string, any>;
  /** Overall processing completion status */
  processingDone: boolean;
  /** Sync status with external systems */
  isSynced: boolean;
}

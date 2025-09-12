import { GuestExtractionResult } from './lib/guestExtractionService.js';

// Main interface for the entire JSON output from yt-dlp
export interface VideoMetadata {
  id: string;
  title: string;
  formats: Format[];
  thumbnails: Thumbnail[];
  thumbnail: string;
  description: string;
  channel_id: string;
  channel_url: string;
  duration: number;
  view_count: number;
  age_limit: number;
  webpage_url: string;
  categories: string[];
  tags: string[];
  playable_in_embed: boolean;
  live_status: string;
  _format_sort_fields: string[];
  automatic_captions: { [key: string]: AutomaticCaption[] };
  subtitles: {};
  comment_count: number;
  chapters: Chapter[];
  heatmap: Heatmap[];
  like_count: number;
  channel: string;
  channel_follower_count: number;
  uploader: string;
  uploader_id: string;
  uploader_url: string;
  upload_date: string;
  timestamp: number;
  availability: string;
  webpage_url_basename: string;
  webpage_url_domain: string;
  extractor: string;
  extractor_key: string;
  display_id: string;
  fulltitle: string;
  duration_string: string;
  is_live: boolean;
  was_live: boolean;
  epoch: number;
  format: string;
  format_id: string;
  ext: string;
  protocol: string;
  language?: string;
  format_note: string;
  filesize_approx?: number;
  tbr?: number;
  width?: number;
  height?: number;
  resolution: string;
  fps?: number;
  dynamic_range?: string;
  vcodec: string;
  vbr?: number;
  aspect_ratio?: number;
  acodec: string;
  abr?: number;
  asr?: number;
  audio_channels?: number;
  _type: string;
  _version: Version;
}

// Interface for each available format
export interface Format {
  format_id: string;
  format_note: string;
  ext: string;
  protocol: string;
  acodec: string;
  vcodec: string;
  url: string;
  width?: number;
  height?: number;
  fps?: number;
  rows?: number;
  columns?: number;
  fragments?: Fragment[];
  audio_ext: string;
  video_ext: string;
  vbr: number;
  abr: number;
  resolution: string;
  aspect_ratio?: number;
  http_headers: HttpHeaders;
  format: string;
  manifest_url?: string;
  language?: string;
  quality?: number;
  has_drm?: boolean;
  source_preference?: number;
  asr?: number;
  filesize?: number;
  audio_channels?: number;
  tbr?: number;
  filesize_approx?: number;
  container?: string;
  downloader_options?: DownloaderOptions;
  dynamic_range?: string;
}

// Interface for video fragments (used in storyboards)
export interface Fragment {
  url: string;
  duration: number;
}

// Interface for HTTP headers
export interface HttpHeaders {
  "User-Agent": string;
  Accept: string;
  "Accept-Language": string;
  "Sec-Fetch-Mode": string;
}

// Interface for downloader options
export interface DownloaderOptions {
  http_chunk_size: number;
}

// Interface for video thumbnails
export interface Thumbnail {
  url: string;
  preference: number;
  id: string;
  height?: number;
  width?: number;
  resolution?: string;
}

// Interface for automatic captions
export interface AutomaticCaption {
  ext: string;
  url: string;
  name: string;
}

// Interface for video chapters
export interface Chapter {
  start_time: number;
  title: string;
  end_time: number;
}

// Interface for the video heatmap
export interface Heatmap {
  start_time: number;
  end_time: number;
  value: number;
}

// Interface for the version information
export interface Version {
  version: string;
  repository: string;
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
  contentType?: 'video';
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

  jobId?: string;
  options?: {
    format?: string;
    quality?: string;
    extractAudio?: boolean;
    priority?: 'high' | 'normal' | 'low';
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
  num_quotes: number;
  num_chunks: number;
  quotingDone: boolean;
  chunkingDone: boolean;
  summarizingDone: boolean;
  audioQuotingDone: boolean;
  videoQuotingDone: boolean;
  audioChunkingDone: boolean;
  videoChunkingDone: boolean;
  episodeTranscribingDone: boolean;
  summaryTranscribingDone: boolean;
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
  episodeImages?: string;
  /** S3 URL for the episode (audio/video file) */
  episodeUri?: string;
  /** Original URL from the source site */
  originalUri: string;
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
  guestImageUrl?: string[];
  
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
  contentType: 'audio' | 'video';
  /** Processing status information (as JSON) */
  processingInfo: EpisodeProcessingInfo;
  /** Additional data as JSON for future use */
  additionalData: Record<string, any>;
  /** Overall processing completion status */
  processingDone: boolean;
  /** Sync status with external systems */
  isSynced: boolean;
}

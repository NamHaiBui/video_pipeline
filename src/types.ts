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
  status: 'pending' | 'downloading_metadata'| 'downloading' | 'merging' | 'uploading' | 'completed' | 'error';
  progress: {
    video?: ProgressInfo;
    audio?: ProgressInfo;
    merged?: ProgressInfo;
  };
  metadata?: VideoMetadata;
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
  jobId?: string;
  url: string;
  options?: {
    format?: string;
    quality?: string;
    extractAudio?: boolean;
    priority?: 'high' | 'normal' | 'low';
  };
  metadata?: Record<string, any>;
}

export interface SQSResponseMessage {
  success: boolean;
  jobId: string;
  message: string;
  timestamp: string;
}

/**
 * Guest description structure for DynamoDB
 */
export interface GuestDescription {
  M: {
    name: { S: string };
    description: { S: string };
    matched_from_cache: { S: string };
    confidence: { S: string };
  };
}

/**
 * Guest name structure for DynamoDB
 */
export interface GuestName {
  M: {
    S: { S: string };
  };
}

/**
 * Image structure for DynamoDB
 */
export interface ImageData {
  artworkUrl600: { S: string };
  artworkUrl60: { S: string };
  artworkUrl160: { S: string };
}

/**
 * Summary metadata structure for DynamoDB
 */
export interface SummaryMetadata {
  topic_metadata: {
    M: {
      start: { L: Array<{ S: string }> };
      end: { L: Array<{ S: string }> };
      topics: { L: Array<{ S: string }> };
      chunk_nos: { L: Array<{ S: string }> };
    };
  };
  summary_transcript_file_name: { S: string };
  summary_duration: { S: string };
}

/**
 * Podcast episode data structure for storing video content as podcast episodes
 * Matches DynamoDB format with type descriptors
 */
export interface PodcastEpisodeData {
  /** Unique identifier for the episode */
  id: string;
  /** Podcast/channel title (derived from uploader) */
  podcast_title: string;
  /** Episode title (derived from video title) */
  episode_title: string;
  /** Audio chunking processing status */
  audio_chunking_status: string;
  /** Audio file URL */
  audio_url: string;
  /** Content chunking processing status */
  chunking_status: string;
  /** Country/region */
  country: string;
  /** Episode description (from video description) */
  description: string;
  /** Whether episode has been downloaded */
  episode_downloaded: boolean;
  /** Episode GUID */
  episode_guid: string;
  /** Episode ID from original source */
  episode_id: string;
  /** Episode duration in milliseconds */
  episode_time_millis: number;
  /** Original episode title with full details */
  episode_title_details: string;
  /** Episode URL */
  episode_url: string;
  /** File name for storage */
  file_name: string;
  /** Content genres/categories - DynamoDB format */
  genres: Array<{ S: string }>;
  /** Number of guests detected */
  guest_count: number;
  /** Description of detected guests - DynamoDB format */
  guest_description: GuestDescription[];
  /** Confidence level of guest extraction */
  guest_extraction_confidence: string;
  /** List of guest names - DynamoDB format */
  guest_names: GuestName[];
  /** Episode image/thumbnail data - DynamoDB format */
  image: ImageData;
  /** Number of chunks created */
  num_chunks: number;
  /** Number of quotes extracted */
  num_quotes: number;
  /** Number of chunks removed during processing */
  num_removed_chunks: number;
  /** Whether this is partial data */
  partial_data: boolean;
  /** List of personalities/guests mentioned - DynamoDB format */
  personalities: Array<{ S: string }>;
  /** Podcast author/channel name */
  podcast_author: string;
  /** Podcast ID from original source */
  podcast_id: string;
  /** Published/upload date */
  published_date: string;
  /** Quote extraction status */
  quote_status: string;
  /** Quotes audio processing status */
  quotes_audio_status: string;
  /** Quotes video processing status */
  quotes_video_status: string;
  /** RSS feed URL for the podcast */
  rss_url: string;
  /** Content source (e.g., 'youtube', 'vimeo') */
  source: string;
  /** Summarization processing status */
  summarization_status: string;
  /** Summary metadata information - DynamoDB format */
  summary_metadata: SummaryMetadata;
  /** Topics extracted from content - DynamoDB format */
  topics: Array<{ S: string }>;
  /** URI for transcript file */
  transcript_uri: string;
  /** Transcription status */
  transcription_status: string;
  /** Video chunking processing status */
  video_chunking_status: string;
  /** Video file name */
  video_file_name: string;
}

/**
 * Analysis result from AI content analysis
 */
export interface ContentAnalysisResult {
  /** Number of personalities detected */
  number_of_personalities: number;
  /** List of personality names */
  personalities: string[];
  /** Whether content matches provided topics */
  topic_match: boolean;
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

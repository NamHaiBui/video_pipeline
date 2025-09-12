/**
 * Podcast Pipeline Constants
 * Centralized location for all podcast processing constants
 */

// =============================================================================
// SERVER CONFIGURATION
// =============================================================================

export const SERVER = {
  DEFAULT_PORT: 3000,
  DEFAULT_HOST: 'localhost',
  SERVICE_NAME: 'podcast-pipeline',
} as const;

// =============================================================================
// DIRECTORY PATHS
// =============================================================================

export const DIRECTORIES = {
  PODCAST_INPUT: './input/podcasts',
  PODCAST_OUTPUT: './output/podcasts',
  AUDIO_OUTPUT: './output/audio',
  TEMP: './temp',
  DOWNLOADS: './downloads',
  TRANSCRIPTS: './output/transcripts',
  METADATA: './output/metadata',
} as const;

// =============================================================================
// PODCAST PROCESSING
// =============================================================================

export const PODCAST = {
  // Audio quality settings optimized for speech
  DEFAULT_AUDIO_QUALITY: 'bestaudio[ext=mp3]/bestaudio',
  PREFERRED_AUDIO_FORMATS: ['mp3', 'opus', 'aac', 'm4a'],
  
  // Video formats (kept minimal, mainly for backup/reference)
  SUPPORTED_VIDEO_FORMATS: ['mp4', 'webm'],
  
  // Processing preferences
  PRIORITIZE_AUDIO: true,
  DEFAULT_YT_DLP_PATH: 'yt-dlp',
  
  // Content filtering for podcasts
  MIN_DURATION_MINUTES: 5, // Skip very short videos
  MAX_DURATION_HOURS: 10,  // Skip extremely long videos
  
  // Podcast-specific metadata
  DEFAULT_GENRE: 'Podcast',
  CONTENT_CATEGORIES: [
    'interview',
    'discussion', 
    'educational',
    'news',
    'entertainment',
    'technology',
    'business',
    'health',
    'science',
  ],
} as const;

// =============================================================================
// RATE LIMITING (Podcast-focused)
// =============================================================================

export const RATE_LIMIT = {
  // Podcast download rate limiting (more conservative for longer content)
  DOWNLOAD_WINDOW_MS: 1800000, // 30 minutes (longer window for podcast processing)
  MAX_DOWNLOADS_PER_WINDOW: 3,  // Fewer concurrent downloads for longer content
  RETRY_AFTER_MESSAGE: '30 minutes',
  
  // General API rate limiting
  GENERAL_WINDOW_MS: 60 * 1000, // 1 minute
  GENERAL_MAX_REQUESTS: 50,     // Reduced for podcast processing
  
  // Progressive slowdown for podcast processing
  SLOWDOWN_DELAY_AFTER: 1,      // Slower after first download
  SLOWDOWN_DELAY_MS: 1000,      // 1 second delay
} as const;

// =============================================================================
// RETRY CONFIGURATION (Podcast-specific)
// =============================================================================

export const RETRY = {
  MAX_RETRIES: 3,
  BACKOFF_MS: 2000,             // Longer backoff for podcast content
  BACKOFF_MULTIPLIER: 2,
  MAX_BACKOFF_MS: 60000,        // 1 minute max backoff
  MAX_DOWNLOAD_RETRIES: 2,      // Fewer retries for long content
} as const;

// =============================================================================
// RETRYABLE ERROR PATTERNS (Podcast-focused)
// =============================================================================

export const RETRYABLE_ERRORS = [
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'Unable to download webpage',
  'HTTP Error 429',
  'HTTP Error 503',
  'HTTP Error 502',
  'temporary failure',
  'Sign in to confirm your age',    // Common for podcast/long-form content
  'Video unavailable',
  'This video is not available',
] as const;

// =============================================================================
// PODCAST CONTENT DETECTION
// =============================================================================

export const PODCAST_INDICATORS = {
  TITLE_KEYWORDS: [
    'podcast',
    'interview',
    'talk',
    'discussion',
    'conversation',
    'episode',
    'show',
    'radio',
    'chat',
    'dialogue',
  ],
  
  DESCRIPTION_KEYWORDS: [
    'subscribe',
    'episode',
    'guest',
    'host',
    'interview',
    'podcast',
    'discussion',
    'listen',
    'audio',
  ],
  
  CHANNEL_INDICATORS: [
    'podcast',
    'radio',
    'interview',
    'talk show',
    'discussions',
  ],
} as const;

// =============================================================================
// LOGGING
// =============================================================================

export const LOGGING = {
  DEFAULT_LEVEL: 'info',
  SERVICE_NAME: 'podcast-pipeline',
  DEFAULT_ENVIRONMENT: 'development',
  
  // CloudWatch
  DEFAULT_LOG_GROUP: 'podcast-pipeline-logs',
  DEFAULT_LOG_STREAM: 'podcast-processor',
  DEFAULT_AWS_REGION: 'us-east-2',
} as const;

// =============================================================================
// METRICS
// =============================================================================

export const METRICS = {
  UNITS: {
    COUNT: 'Count',
    SECONDS: 'Seconds',
    PERCENT: 'Percent',
    BYTES: 'Bytes',
    KILOBYTES: 'Kilobytes',
    MEGABYTES: 'Megabytes',
    GIGABYTES: 'Gigabytes',
    MINUTES: 'Minutes',
    HOURS: 'Hours',
  },
  
  NAMES: {
    PODCAST_STARTED: 'PodcastProcessingStarted',
    PODCAST_COMPLETED: 'PodcastProcessingCompleted',
    PODCAST_FAILED: 'PodcastProcessingFailed',
    PODCAST_RETRIED: 'PodcastProcessingRetried',
    PODCAST_DURATION: 'PodcastProcessingDuration',
    AUDIO_EXTRACTION_STARTED: 'AudioExtractionStarted',
    AUDIO_EXTRACTION_COMPLETED: 'AudioExtractionCompleted',
    AUDIO_SIZE: 'AudioFileSize',
    TRANSCRIPTION_STARTED: 'TranscriptionStarted',
    TRANSCRIPTION_COMPLETED: 'TranscriptionCompleted',
    ACTIVE_PODCAST_JOBS: 'ActivePodcastJobs',
    API_REQUEST: 'ApiRequest',
    RATE_LIMIT_HIT: 'RateLimitHit',
    CONTENT_DURATION: 'ContentDuration',
  PODCAST_EPISODES_PROCESSED: 'PodcastEpisodesProcessed',
  DOWNLOAD_FAILED: 'DownloadFailed',
  EPISODE_SKIPPED: 'EpisodeSkipped',
  YTDLP_FAILURE: 'YtDlpFailure'
  },
} as const;

// =============================================================================
// HTTP STATUS CODES
// =============================================================================

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

// =============================================================================
// DOWNLOAD TYPES
// =============================================================================


// =============================================================================
// TIME CONSTANTS
// =============================================================================

export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  
  // Conversion helpers
  SECONDS_IN_MINUTE: 60,
  SECONDS_IN_HOUR: 3600,
  MINUTES_IN_HOUR: 60,
} as const;

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

export const ENV_VARS = {
  // Core
  NODE_ENV: 'NODE_ENV',
  PORT: 'PORT',
  HOST: 'HOST',
  
  // API Keys
  YOUTUBE_API_KEY: 'YOUTUBE_API_KEY',
  
  // AWS
  AWS_REGION: 'AWS_REGION',
  AWS_ACCESS_KEY_ID: 'AWS_ACCESS_KEY_ID',
  AWS_SECRET_ACCESS_KEY: 'AWS_SECRET_ACCESS_KEY',
  AWS_ENDPOINT_URL: 'AWS_ENDPOINT_URL',
  
  // Paths
  VIDEO_INPUT_DIR: 'VIDEO_INPUT_DIR',
  VIDEO_OUTPUT_DIR: 'VIDEO_OUTPUT_DIR',
  TEMP_DIR: 'TEMP_DIR',
  FFMPEG_PATH: 'FFMPEG_PATH',
  YT_DLP_PATH: 'YT_DLP_PATH',
  
  // Video settings
  DEFAULT_VIDEO_QUALITY: 'DEFAULT_VIDEO_QUALITY',
  SUPPORTED_FORMATS: 'SUPPORTED_FORMATS',
  
  // Logging
  LOG_LEVEL: 'LOG_LEVEL',
  CLOUDWATCH_LOG_GROUP: 'CLOUDWATCH_LOG_GROUP',
  CLOUDWATCH_LOG_STREAM: 'CLOUDWATCH_LOG_STREAM',
  CLOUDWATCH_METRICS_ENABLED: 'CLOUDWATCH_METRICS_ENABLED',
  YTDLP_VERBOSE_WARNINGS: 'YTDLP_VERBOSE_WARNINGS',
  
  // Rate limiting
  MAX_DOWNLOADS_PER_WINDOW: 'MAX_DOWNLOADS_PER_WINDOW',
  RATE_LIMIT_WINDOW_MS: 'RATE_LIMIT_WINDOW_MS',
  SLOW_DOWN_DELAY_MS: 'SLOW_DOWN_DELAY_MS',
  
  // Retry configuration
  MAX_RETRIES: 'MAX_RETRIES',
  MAX_DOWNLOAD_RETRIES: 'MAX_DOWNLOAD_RETRIES',
  RETRY_BACKOFF_MS: 'RETRY_BACKOFF_MS',
} as const;

// =============================================================================
// REGEX PATTERNS
// =============================================================================

export const REGEX = {
  // YouTube URL patterns
  YOUTUBE_URL: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/.+/,
  
  // ISO 8601 duration format (PT1M30S)
  ISO_DURATION: /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/,
  
  // Common video file extensions
  VIDEO_EXTENSION: /\.(mp4|avi|mov|mkv|webm|flv|wmv)$/i,
  
  // Common audio file extensions
  AUDIO_EXTENSION: /\.(mp3|wav|flac|aac|ogg|m4a)$/i,
} as const;

// =============================================================================
// ERROR MESSAGES
// =============================================================================

export const ERROR_MESSAGES = {
  INVALID_URL: 'Invalid YouTube URL provided',
  MISSING_URL: 'URL is required',
  INVALID_QUALITY: 'Invalid video quality specified',
  UNSUPPORTED_FORMAT: 'Unsupported video format',
  DOWNLOAD_FAILED: 'Download failed',
  JOB_NOT_FOUND: 'Job not found',
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please try again later.',
  DOWNLOAD_LIMIT_EXCEEDED: 'Too many download requests. Please try again later.',
  INTERNAL_ERROR: 'Internal server error',
  METADATA_FETCH_FAILED: 'Failed to fetch video metadata',
} as const;

// =============================================================================
// SUCCESS MESSAGES
// =============================================================================

export const SUCCESS_MESSAGES = {
  PODCAST_PROCESSING_STARTED: 'Podcast processing started successfully',
  AUDIO_EXTRACTION_COMPLETED: 'Audio extraction completed successfully',
  PODCAST_EPISODE_CREATED: 'Podcast episode created successfully',
  METADATA_FETCHED: 'Video metadata fetched successfully',
  TRANSCRIPTION_STARTED: 'Transcription started successfully',
} as const;

// =============================================================================
// BINARY PATHS
// =============================================================================

export const BINARY_PATHS = {
  FFMPEG: './bin/ffmpeg',
  FFPROBE: './bin/ffprobe',
  YT_DLP: './bin/yt-dlp',
} as const;

// =============================================================================
// FILE EXTENSIONS
// =============================================================================

export const FILE_EXTENSIONS = {
  AUDIO: {
    MP3: '.mp3',
    WAV: '.wav',
    FLAC: '.flac',
    AAC: '.aac',
    OGG: '.ogg',
    M4A: '.m4a',
    OPUS: '.opus',
    WEBM: '.webm', // Audio webm
  },
  VIDEO: {
    MP4: '.mp4',
    WEBM: '.webm',
    MKV: '.mkv',
  },
  TRANSCRIPTS: {
    TXT: '.txt',
    SRT: '.srt',
    VTT: '.vtt',
    JSON: '.json',
  },
  METADATA: {
    JSON: '.json',
    XML: '.xml',
  },
} as const;

// =============================================================================
// PODCAST-SPECIFIC ENVIRONMENT VARIABLES
// =============================================================================

export const PODCAST_ENV_VARS = {
  // Podcast processing
  PODCAST_CONVERSION_ENABLED: 'PODCAST_CONVERSION_ENABLED',
  PODCAST_TOPIC_KEYWORDS: 'PODCAST_TOPIC_KEYWORDS',
  PODCAST_PERSON_KEYWORDS: 'PODCAST_PERSON_KEYWORDS',
  PODCAST_AI_ANALYSIS_ENABLED: 'PODCAST_AI_ANALYSIS_ENABLED',
  
  // Audio processing
  PREFERRED_AUDIO_FORMAT: 'PREFERRED_AUDIO_FORMAT',
  AUDIO_QUALITY: 'AUDIO_QUALITY',
  
  // Transcription
  TRANSCRIPTION_ENABLED: 'TRANSCRIPTION_ENABLED',
  TRANSCRIPTION_SERVICE: 'TRANSCRIPTION_SERVICE',
  
  // Content filtering
  MIN_PODCAST_DURATION: 'MIN_PODCAST_DURATION',
  MAX_PODCAST_DURATION: 'MAX_PODCAST_DURATION',
} as const;

// =============================================================================
// EXPORT TYPES
// =============================================================================

export type PodcastFormat = typeof PODCAST.PREFERRED_AUDIO_FORMATS[number];
export type MetricUnit = typeof METRICS.UNITS[keyof typeof METRICS.UNITS];
export type RetryableError = typeof RETRYABLE_ERRORS[number];
export type PodcastCategory = typeof PODCAST.CONTENT_CATEGORIES[number];
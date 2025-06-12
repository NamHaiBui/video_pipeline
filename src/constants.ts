/**
 * Application Constants
 * Centralized location for all application constants
 */

// =============================================================================
// SERVER CONFIGURATION
// =============================================================================

export const SERVER = {
  DEFAULT_PORT: 3000,
  DEFAULT_HOST: 'localhost',
} as const;

// =============================================================================
// DIRECTORY PATHS
// =============================================================================

export const DIRECTORIES = {
  VIDEO_INPUT: './input',
  VIDEO_OUTPUT: './output',
  TEMP: './temp',
  DOWNLOADS: './downloads',
} as const;

// =============================================================================
// VIDEO PROCESSING
// =============================================================================

export const VIDEO = {
  DEFAULT_QUALITY: '720p',
  SUPPORTED_FORMATS: ['mp4', 'avi', 'mov', 'mkv'],
  DEFAULT_YT_DLP_PATH: 'yt-dlp',
} as const;

// =============================================================================
// RATE LIMITING
// =============================================================================

export const RATE_LIMIT = {
  // Download rate limiting
  DOWNLOAD_WINDOW_MS: 900000, // 15 minutes
  MAX_DOWNLOADS_PER_WINDOW: 5,
  RETRY_AFTER_MESSAGE: '15 minutes',
  
  // General API rate limiting
  GENERAL_WINDOW_MS: 60 * 1000, // 1 minute
  GENERAL_MAX_REQUESTS: 100,
  
  // Progressive slowdown
  SLOWDOWN_DELAY_AFTER: 2,
  SLOWDOWN_DELAY_MS: 500,
} as const;

// =============================================================================
// RETRY CONFIGURATION
// =============================================================================

export const RETRY = {
  MAX_RETRIES: 3,
  BACKOFF_MS: 1000,
  BACKOFF_MULTIPLIER: 2,
  MAX_BACKOFF_MS: 30000,
  MAX_DOWNLOAD_RETRIES: 3,
} as const;

// =============================================================================
// RETRYABLE ERROR PATTERNS
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
] as const;

// =============================================================================
// LOGGING
// =============================================================================

export const LOGGING = {
  DEFAULT_LEVEL: 'info',
  SERVICE_NAME: 'video-pipeline',
  DEFAULT_ENVIRONMENT: 'development',
  
  // CloudWatch
  DEFAULT_LOG_GROUP: 'video-pipeline-logs',
  DEFAULT_LOG_STREAM: 'app-stream',
  DEFAULT_AWS_REGION: 'us-east-1',
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
  },
  
  NAMES: {
    JOB_STARTED: 'JobStarted',
    JOB_COMPLETED: 'JobCompleted',
    JOB_FAILED: 'JobFailed',
    JOB_RETRIED: 'JobRetried',
    JOB_DURATION: 'JobDuration',
    DOWNLOAD_STARTED: 'DownloadStarted',
    DOWNLOAD_COMPLETED: 'DownloadCompleted',
    DOWNLOAD_SIZE: 'DownloadSize',
    ACTIVE_JOBS: 'ActiveJobs',
    API_REQUEST: 'ApiRequest',
    RATE_LIMIT_HIT: 'RateLimitHit',
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

export const DOWNLOAD_TYPES = {
  VIDEO: 'video',
  AUDIO: 'audio',
} as const;

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
  DOWNLOAD_STARTED: 'Download started successfully',
  DOWNLOAD_COMPLETED: 'Download completed successfully',
  JOB_CREATED: 'Job created successfully',
  METADATA_FETCHED: 'Video metadata fetched successfully',
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
  VIDEO: {
    MP4: '.mp4',
    AVI: '.avi',
    MOV: '.mov',
    MKV: '.mkv',
    WEBM: '.webm',
    FLV: '.flv',
    WMV: '.wmv',
  },
  AUDIO: {
    MP3: '.mp3',
    WAV: '.wav',
    FLAC: '.flac',
    AAC: '.aac',
    OGG: '.ogg',
    M4A: '.m4a',
  },
} as const;

// =============================================================================
// EXPORT TYPES
// =============================================================================

export type VideoFormat = typeof VIDEO.SUPPORTED_FORMATS[number];
export type DownloadType = typeof DOWNLOAD_TYPES[keyof typeof DOWNLOAD_TYPES];
export type MetricUnit = typeof METRICS.UNITS[keyof typeof METRICS.UNITS];
export type RetryableError = typeof RETRYABLE_ERRORS[number];


export const AWS_DATABASE = {
    
}
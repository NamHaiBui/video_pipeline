import { create_slug } from './utils/utils.js';
import { VideoMetadata } from '../types.js';

export interface S3KeyConfig {
  videoPrefix: string;
  audioPrefix: string;
}

/**
 * Get S3 key configuration from environment variables
 */
export function getS3KeyConfig(): S3KeyConfig {
  return {
    videoPrefix: process.env.S3_VIDEO_KEY_PREFIX || '',
    audioPrefix: process.env.S3_AUDIO_KEY_PREFIX || ''
  };
}
export function generateM3U8S3Key(metadata: VideoMetadata): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = create_slug(metadata.title);
  const key = `${podcastTitleSlug}/${episodeTitleSlug}/original/video/master.m3u8`;
  return config.videoPrefix ? `${config.videoPrefix}${key}` : key;
}
/**
 * Generate S3 key for audio files using unified naming convention
 * Format: [prefix]podcast-title-slug/episode-title-slug/original/audio/filename.mp3
 */
export function generateAudioS3Key(metadata: VideoMetadata, customFilename?: string): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);

  const key = `${podcastTitleSlug}/${episodeTitleSlug}/original/audio/${episodeTitleSlug}.mp3`;
  return config.audioPrefix ? `${config.audioPrefix}${key}` : key;
}
export function getPublicUrl(bucket: string, key: string): string {
        // In a real scenario, this might use getSignedUrl or a static URL pattern
        return `https://${bucket}.s3.us-east-1.amazonaws.com/${key}`;
    }
/**
 * Generate S3 key for video files using unified naming convention
 * Format: [prefix]podcast-title-slug/episode-title-slug/original/video/master.{extension}
 */
export function generateVideoS3Key(metadata: VideoMetadata, extension: string, videoDefinition:string,customFilename?: string,): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);
  
  // Ensure extension starts with a dot
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;

  const key = `${podcastTitleSlug}/${episodeTitleSlug}/original/videos/${videoDefinition}${normalizedExtension}`;
  return config.videoPrefix ? `${config.videoPrefix}${key}` : key;
}

export function generateLowerDefVideoS3Key(metadata: VideoMetadata, definition: string, customFilename?: string): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);

  const key = `${podcastTitleSlug}/${episodeTitleSlug}/original/videos/${definition}.mp4`;
  return config.videoPrefix ? `${config.videoPrefix}${key}` : key;
}

export function generateThumbnailS3Key(metadata: VideoMetadata, customFilename?: string): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);

  const key = `${podcastTitleSlug}/${episodeTitleSlug}/original/image/${episodeTitleSlug}.jpg`;
  return config.videoPrefix ? `${config.videoPrefix}${key}` : key;
}

/**
 * Extract podcast and episode slugs from an existing S3 key
 * Returns null if the key doesn't match the expected format
 */
export function parseS3Key(s3Key: string): { podcastSlug: string; episodeSlug: string; type: string; filename: string } | null {
  // Pattern for audio/video: podcast-slug/episode-slug/original/(audio|video)/filename
  const mediaMatch = s3Key.match(/([^\/]+)\/([^\/]+)\/original\/(audio|video)\/([^\/]+)$/);
  
  if (mediaMatch) {
    return {
      podcastSlug: mediaMatch[1],
      episodeSlug: mediaMatch[2],
      type: mediaMatch[3], 
      filename: mediaMatch[4]
    };
  }
  
  // Pattern for metadata: podcast-slug/episode-slug/original/filename
  const metadataMatch = s3Key.match(/([^\/]+)\/([^\/]+)\/original\/([^\/]+)$/);
  
  if (metadataMatch) {
    return {
      podcastSlug: metadataMatch[1],
      episodeSlug: metadataMatch[2],
      type: 'metadata',
      filename: metadataMatch[3]
    };
  }
  
  return null;
}

export function getS3ArtifactBucket(): string {
  const bucket = process.env.S3_ARTIFACT_BUCKET || 'spice-episode-artifacts';
  if (!bucket) {
    throw new Error('S3_ARTIFACT_BUCKET environment variable is not set');
  }
  return bucket;
}

/**
 * Validate that S3 key follows the unified naming convention
 */
export function isValidUnifiedS3Key(s3Key: string): boolean {
  // Should match pattern for audio/video: [prefix]podcast-slug/episode-slug/original/(audio|video)/filename
  const mediaPattern = /^(?:[^\/]+\/)?[a-z0-9-]+\/[a-z0-9-]+\/original\/(audio|video)\/[^\/]+$/;
  
  // Should match pattern for metadata: [prefix]podcast-slug/episode-slug/original/filename
  const metadataPattern = /^(?:[^\/]+\/)?[a-z0-9-]+\/[a-z0-9-]+\/original\/[^\/]+$/;
  
  return mediaPattern.test(s3Key) || metadataPattern.test(s3Key);
}


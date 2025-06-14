/**
 * Centralized S3 key generation utilities for consistent naming across the application
 * Implements the unified naming format: s3://pd-audio-storage/podcast-title-slug/episode-title-slug.extension
 */

import { create_slug } from './utils/utils.js';
import { VideoMetadata } from '../types.js';

export interface S3KeyConfig {
  videoPrefix: string;
  audioPrefix: string;
  metadataPrefix: string;
}

/**
 * Get S3 key configuration from environment variables
 */
export function getS3KeyConfig(): S3KeyConfig {
  return {
    videoPrefix: process.env.S3_VIDEO_KEY_PREFIX || '',
    audioPrefix: process.env.S3_AUDIO_KEY_PREFIX || '',
    metadataPrefix: process.env.S3_METADATA_KEY_PREFIX || ''
  };
}

/**
 * Generate S3 key for audio files using unified naming convention
 * Format: [prefix]podcast-title-slug/episode-title-slug.mp3
 */
export function generateAudioS3Key(metadata: VideoMetadata, customFilename?: string): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);
  
  const key = `${podcastTitleSlug}/${episodeTitleSlug}.mp3`;
  return config.audioPrefix ? `${config.audioPrefix}${key}` : key;
}

/**
 * Generate S3 key for video files using unified naming convention
 * Format: [prefix]podcast-title-slug/episode-title-slug.{extension}
 */
export function generateVideoS3Key(metadata: VideoMetadata, extension: string, customFilename?: string): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);
  
  // Ensure extension starts with a dot
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  
  const key = `${podcastTitleSlug}/${episodeTitleSlug}${normalizedExtension}`;
  return config.videoPrefix ? `${config.videoPrefix}${key}` : key;
}

/**
 * Generate S3 key for metadata files using unified naming convention
 * Format: [prefix]podcast-title-slug/episode-title-slug_metadata.json
 */
export function generateMetadataS3Key(metadata: VideoMetadata, customFilename?: string): string {
  const config = getS3KeyConfig();
  const podcastTitleSlug = create_slug(metadata.uploader);
  const episodeTitleSlug = customFilename ? create_slug(customFilename) : create_slug(metadata.title);
  
  const key = `${podcastTitleSlug}/${episodeTitleSlug}_metadata.json`;
  return config.metadataPrefix ? `${config.metadataPrefix}${key}` : key;
}

/**
 * Extract podcast and episode slugs from an existing S3 key
 * Returns null if the key doesn't match the expected format
 */
export function parseS3Key(s3Key: string): { podcastSlug: string; episodeSlug: string; extension: string } | null {
  // Remove any prefix by finding the pattern
  const match = s3Key.match(/([^\/]+)\/([^\/]+)\.([^.]+)$/);
  
  if (!match) {
    return null;
  }
  
  return {
    podcastSlug: match[1],
    episodeSlug: match[2],
    extension: match[3]
  };
}

/**
 * Get the audio bucket name based on environment
 */
export function getAudioBucketName(): string {
  return process.env.S3_AUDIO_BUCKET || 'pd-audio-storage';
}

/**
 * Get the video bucket name based on environment
 */
export function getVideoBucketName(): string {
  return process.env.S3_VIDEO_BUCKET || 'pd-video-storage';
}

/**
 * Get the metadata bucket name (uses audio bucket by default)
 */
export function getMetadataBucketName(): string {
  return process.env.S3_METADATA_BUCKET || getAudioBucketName();
}

/**
 * Validate that S3 key follows the unified naming convention
 */
export function isValidUnifiedS3Key(s3Key: string): boolean {
  // Should match pattern: [prefix]podcast-slug/episode-slug.extension
  const pattern = /^(?:[^\/]+\/)?[a-z0-9-]+\/[a-z0-9-]+\.[a-z0-9]+$/;
  return pattern.test(s3Key);
}


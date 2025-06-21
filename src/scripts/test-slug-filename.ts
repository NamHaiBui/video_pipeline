#!/usr/bin/env node

/**
 * Test script to verify slug-based filename generation
 * This tests the new podcast-title/episode-name naming structure
 */

import { create_slug } from '../lib/utils/utils.js';
import { generateAudioS3Key, generateVideoS3Key, generateMetadataS3Key } from '../lib/s3KeyUtils.js';
import { VideoMetadata } from '../types.js';

// Mock video metadata for testing
const testMetadata: VideoMetadata = {
  id: 'dQw4w9WgXcQ',
  title: 'Rick Astley - Never Gonna Give You Up! (Official Video)',
  uploader: 'Rick Astley Official',
  description: 'The official Rick Astley "Never Gonna Give You Up" music video',
  duration: 212,
  upload_date: '20211208',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  thumbnails: [
    {
      url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      id: 'maxresdefault',
      height: 720,
      width: 1280
    }
  ],
  tags: ['music', 'pop', 'classic'],
  country: 'GB',
  uploader_id: 'rickastley',
  channel: 'Rick Astley Official',
  channel_id: 'UCuAXFkgsw1L7xaCfnd5JJOw',
  view_count: 1000000000,
  like_count: 15000000,
  availability: 'public',
  age_limit: 0,
  categories: ['Music'],
  live_status: 'not_live',
  playable_in_embed: true,
  extractor: 'youtube',
  extractor_key: 'Youtube',
  epoch: 1639440000,
  format_id: '140',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  manifest_url: '',
  tbr: 128,
  ext: 'mp4',
  protocol: 'https',
  language: 'en',
  format_note: 'DASH audio',
  filesize_approx: 3400000,
  formats: [],
  _filename: 'Rick Astley - Never Gonna Give You Up! (Official Video) [dQw4w9WgXcQ].mp4',
  fulltitle: 'Rick Astley - Never Gonna Give You Up! (Official Video)'
};

console.log('🧪 Testing slug-based filename generation...\n');

// Test slug generation
console.log('1. Testing slug generation:');
const podcastSlug = create_slug(testMetadata.uploader);
const episodeSlug = create_slug(testMetadata.title);
console.log(`   Podcast title: "${testMetadata.uploader}" → "${podcastSlug}"`);
console.log(`   Episode title: "${testMetadata.title}" → "${episodeSlug}"`);
console.log(`   Expected structure: "${podcastSlug}/${episodeSlug}"`);

// Test S3 key generation
console.log('\n2. Testing S3 key generation:');
const audioS3Key = generateAudioS3Key(testMetadata);
const videoS3Key = generateVideoS3Key(testMetadata, 'mp4');
const metadataS3Key = generateMetadataS3Key(testMetadata);

console.log(`   Audio S3 key: "${audioS3Key}"`);
console.log(`   Video S3 key: "${videoS3Key}"`);
console.log(`   Metadata S3 key: "${metadataS3Key}"`);

// Test edge cases
console.log('\n3. Testing edge cases:');

const edgeCaseMetadata: VideoMetadata = {
  ...testMetadata,
  title: 'Test! Video with @#$%^&*() Special Characters & Émojis 🎵',
  uploader: 'Chäñńél Námé wíth Spëcîàl Cháracters!'
};

const edgePodcastSlug = create_slug(edgeCaseMetadata.uploader);
const edgeEpisodeSlug = create_slug(edgeCaseMetadata.title);
const edgeAudioS3Key = generateAudioS3Key(edgeCaseMetadata);

console.log(`   Edge podcast title: "${edgeCaseMetadata.uploader}" → "${edgePodcastSlug}"`);
console.log(`   Edge episode title: "${edgeCaseMetadata.title}" → "${edgeEpisodeSlug}"`);
console.log(`   Edge audio S3 key: "${edgeAudioS3Key}"`);

// Test empty/null values
console.log('\n4. Testing empty/null values:');
const emptyMetadata: VideoMetadata = {
  ...testMetadata,
  title: '',
  uploader: ''
};

const emptyPodcastSlug = create_slug(emptyMetadata.uploader);
const emptyEpisodeSlug = create_slug(emptyMetadata.title);
const emptyAudioS3Key = generateAudioS3Key(emptyMetadata);

console.log(`   Empty podcast title: "" → "${emptyPodcastSlug}"`);
console.log(`   Empty episode title: "" → "${emptyEpisodeSlug}"`);
console.log(`   Empty audio S3 key: "${emptyAudioS3Key}"`);

// Validate naming convention
console.log('\n5. Validating naming convention:');
const isValidFormat = (key: string) => {
  const pattern = /^[a-z0-9-]+\/[a-z0-9-]+\.[a-z0-9]+$/;
  return pattern.test(key);
};

console.log(`   Audio key "${audioS3Key}" is valid: ${isValidFormat(audioS3Key)}`);
console.log(`   Video key "${videoS3Key}" is valid: ${isValidFormat(videoS3Key)}`);
console.log(`   Edge audio key "${edgeAudioS3Key}" is valid: ${isValidFormat(edgeAudioS3Key)}`);
console.log(`   Empty audio key "${emptyAudioS3Key}" is valid: ${isValidFormat(emptyAudioS3Key)}`);

console.log('\n✅ Slug-based filename generation test completed!');
console.log('📁 All files will now be saved with the structure: podcast-title-slug/episode-name-slug.extension');
console.log('☁️  S3 storage will use the same consistent naming pattern');

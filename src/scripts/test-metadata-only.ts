/**
 * Simple Metadata Processing Test
 * 
 * This script processes video metadata and converts it to podcast episode data
 * WITHOUT uploading to database or creating log entries.
 * 
 * Usage: npm run test:metadata-only
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PodcastService } from '@/lib/podcastService';
import { VideoMetadata } from '@/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METADATA_SAMPLE_PATH = path.resolve(__dirname, '../../downloads/f398a192-e011-4b97-bf2e-d690884b6090_metadata.json');

class SimplePodcastService extends PodcastService {
  constructor() {
    // Initialize with minimal config for testing only
    super({
      region: 'us-east-1',
      episodeTableName: 'test-episodes',
      podcastRSSLinkTableName:'test-podcast-rss-links',
    });
  }

  // Override public methods to prevent database operations and external calls
  async ensureEpisodeTableExists(): Promise<void> {
    console.log('📋 Skipping table creation for test');
  }

  async insertEpisode(): Promise<boolean> {
    console.log('💾 Skipping database insert for test');
    return true;
  }
}

async function main() {
  console.log('🎙️ Simple Metadata Processing Test 🎙️\n');
  
  try {
    // Load metadata from sample file
    console.log('📄 Loading metadata from file...');
    const metadataRaw = fs.readFileSync(METADATA_SAMPLE_PATH, 'utf-8');
    const metadata = JSON.parse(metadataRaw) as VideoMetadata;
    
    console.log(`📋 Video Title: ${metadata.title}`);
    console.log(`👤 Channel: ${metadata.uploader}`);
    console.log(`⏱️ Duration: ${Math.floor(metadata.duration / 60)} minutes`);
    console.log(`📅 Upload Date: ${metadata.upload_date}\n`);
    
    // Initialize simple podcast service
    const podcastService = new SimplePodcastService();
    
    // Process the video metadata as a podcast episode
    const audioUrl = `https://example.com/downloads/${metadata.id}.mp3`;
    const videoUrl = `https://example.com/downloads/${metadata.id}.mp4`;
    console.log('🔄 Converting video metadata to podcast episode...');
    const podcastEpisode = await podcastService.processEpisodeMetadata(
      metadata,
    );
    
    console.log('\n✅ Successfully converted video to podcast episode:\n');
    console.log('📊 Episode Data Structure:');
    console.log('========================');
    console.log(`ID: ${podcastEpisode.id}`);
    console.log(`Podcast Title: ${podcastEpisode.podcast_title}`);
    console.log(`Episode Title: ${podcastEpisode.episode_title}`);
    console.log(`File Name: ${podcastEpisode.file_name}`);
    console.log(`Audio URL: ${podcastEpisode.audio_url}`);
    console.log(`Description: ${podcastEpisode.description.substring(0, 100)}...`);
    console.log(`Published Date: ${podcastEpisode.published_date}`);
    console.log(`Source: ${podcastEpisode.source}`);
    console.log(`Episode Downloaded: ${podcastEpisode.episode_downloaded}`);
    console.log(`Transcription Status: ${podcastEpisode.transcription_status}`);
    console.log(`Audio Chunking Status: ${podcastEpisode.audio_chunking_status}`);
    console.log(`Chunking Status: ${podcastEpisode.chunking_status}`);
    console.log(`Summarization Status: ${podcastEpisode.summarization_status}`);
    console.log(`Topics: [${podcastEpisode.topics.join(', ')}]`);
    console.log(`Personalities: [${podcastEpisode.personalities.join(', ')}]`);
    console.log(`Guest Count: ${podcastEpisode.guest_count}`);
    console.log(`Number of Chunks: ${podcastEpisode.num_chunks}`);
    console.log(`Partial Data: ${podcastEpisode.partial_data}`);
    
    if (podcastEpisode.episode_time_millis) {
      console.log(`Duration (minutes): ${Math.floor(podcastEpisode.episode_time_millis / 60000)}`);
    }

    console.log('\n📝 Full JSON Output:');
    console.log('====================');
    console.log(JSON.stringify(podcastEpisode, null, 2));
    
  } catch (error: any) {
    console.error(`❌ Error processing metadata: ${error.message}`);
    console.error(error.stack);
  }
}

// Run the main function
main().catch(error => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});

#!/usr/bin/env tsx

import { createDynamoDBServiceFromEnv } from '../lib/dynamoService.js';
import { config } from 'dotenv';

// Load environment variables
config({ path: '.env.localstack' });

/**
 * Query and display podcast episodes data
 */
async function queryPodcastData() {
  console.log('🔍 Querying podcast episodes data...\n');

  // Initialize DynamoDB service
  const dynamoService = createDynamoDBServiceFromEnv();
  if (!dynamoService) {
    console.error('❌ Failed to initialize DynamoDB service');
    process.exit(1);
  }

  try {
    // Query all episodes with 'new' transcription status
    console.log('📋 Episodes needing transcription:');
    const newEpisodes = await dynamoService.getEpisodesByTranscriptionStatus('new', 10);
    
    if (newEpisodes.length > 0) {
      for (const episode of newEpisodes) {
        console.log(`   🎙️ ${episode.episode_title_details}`);
        console.log(`      Podcast: ${episode.podcast_title}`);
        console.log(`      Duration: ${Math.floor((episode.episode_time_millis || 0) / 60000)}:${Math.floor(((episode.episode_time_millis || 0) % 60000) / 1000).toString().padStart(2, '0')}`);
        console.log(`      Topics: ${episode.topics.join(', ')}`);
        console.log(`      File: ${episode.file_name}`);
        console.log(`      Views: ${episode.view_count?.toLocaleString()}`);
        console.log();
      }
    } else {
      console.log('   No episodes found with "new" status');
    }

    // Query episodes by podcast title
    console.log('📋 Episodes by podcast title "trash taste":');
    const trashTasteEpisodes = await dynamoService.getPodcastEpisodesByTitle('trash taste', 10);
    
    console.log(`   Found ${trashTasteEpisodes.length} episodes:`);
    for (const episode of trashTasteEpisodes) {
      console.log(`   📅 ${episode.published_date.split(' ')[0]} - ${episode.episode_title_details}`);
      console.log(`      Topics: ${episode.topics.length > 0 ? episode.topics.join(', ') : 'None'}`);
      console.log(`      Views: ${episode.view_count?.toLocaleString()}`);
      console.log(`      Status: ${episode.transcription_status}`);
      console.log();
    }

    // Demonstrate updating transcription status
    if (trashTasteEpisodes.length > 0) {
      const episodeToUpdate = trashTasteEpisodes[0];
      console.log(`🔄 Updating transcription status for: ${episodeToUpdate.episode_title_details}`);
      
      const updateSuccess = await dynamoService.updateTranscriptionStatus(
        episodeToUpdate.id,
        'in_progress'
      );
      
      if (updateSuccess) {
        console.log('✅ Successfully updated transcription status to "in_progress"');
        
        // Verify the update
        const updatedEpisode = await dynamoService.getPodcastEpisode(episodeToUpdate.id);
        if (updatedEpisode) {
          console.log(`✅ Verified: Status is now "${updatedEpisode.transcription_status}"`);
        }
      } else {
        console.log('❌ Failed to update transcription status');
      }
    }

    console.log('\n🎯 Query Examples Completed!');
    console.log('\n💡 You can now use this data for:');
    console.log('   • Building a podcast management dashboard');
    console.log('   • Triggering transcription services');
    console.log('   • Content analysis and categorization');
    console.log('   • Search and discovery features');
    console.log('   • RSS feed generation');
    console.log('   • Analytics and reporting');

  } catch (error: any) {
    console.error('❌ Query failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Only run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  queryPodcastData();
}

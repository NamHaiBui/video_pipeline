#!/usr/bin/env node

/**
 * Test script for video trimming queue functionality
 * This script simulates the completion check and queue logic
 */

import { DynamoDBService } from '../src/lib/dynamoService.js';
import { createSQSServiceFromEnv } from '../src/lib/sqsService.js';
import { logger } from '../src/lib/logger.js';
import dotenv from 'dotenv';

// Load environment configuration
dotenv.config();

const dynamoService = new DynamoDBService({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  podcastEpisodesTableName: process.env.DYNAMODB_PODCAST_EPISODES_TABLE || 'PodcastEpisodeStoreTest'
});

const sqsService = createSQSServiceFromEnv();

/**
 * Test function to check video trimming queue functionality
 */
async function testVideoTrimmingQueue(episodeId: string): Promise<void> {
  console.log(`🧪 Testing video trimming queue functionality for episode: ${episodeId}`);
  
  if (!sqsService) {
    console.error('❌ SQS service not configured');
    process.exit(1);
  }

  try {
    // Get episode data from DynamoDB
    const episode = await dynamoService.getPodcastEpisode(episodeId);
    
    if (!episode) {
      console.error(`❌ Episode ${episodeId} not found in database`);
      process.exit(1);
    }

    console.log(`📋 Episode found: ${episode.episode_title}`);
    console.log(`📊 Status check:`);
    console.log(`   - quotes_audio_status: ${episode.quotes_audio_status}`);
    console.log(`   - chunking_status: ${episode.chunking_status}`);
    
    // Check if all required statuses are COMPLETED
    if (episode.quotes_audio_status === 'COMPLETED' && episode.chunking_status === 'COMPLETED') {
      console.log('✅ All processing statuses are COMPLETED');
      
      // Get video trimming queue URL from environment or use default
      const trimQueueUrl = process.env.VIDEO_TRIMMING_QUEUE_URL || 'https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming';
      const messageBody = JSON.stringify({ id: episodeId });
      
      console.log(`📤 Sending message to video trimming queue...`);
      console.log(`   Queue URL: ${trimQueueUrl}`);
      console.log(`   Message Body: ${messageBody}`);
      
      const messageId = await sqsService.sendMessage(messageBody, undefined, trimQueueUrl);
      
      console.log(`✅ Successfully queued episode ${episodeId} to video trimming queue`);
      console.log(`   Message ID: ${messageId}`);
    } else {
      console.log('⏳ Episode not ready for trimming');
      console.log(`   Required: quotes_audio_status=COMPLETED, chunking_status=COMPLETED`);
      console.log(`   Current: quotes_audio_status=${episode.quotes_audio_status}, chunking_status=${episode.chunking_status}`);
    }
    
  } catch (error: any) {
    console.error(`❌ Test failed: ${error.message}`);
    process.exit(1);
  }
}

// Get episode ID from command line arguments
const episodeId = process.argv[2];

if (!episodeId) {
  console.error('❌ Usage: npm run test:trimming-queue <episode-id>');
  console.error('   Example: npm run test:trimming-queue abc123-def456-ghi789');
  process.exit(1);
}

// Run the test
testVideoTrimmingQueue(episodeId).then(() => {
  console.log('🎉 Test completed successfully');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Test failed:', error.message);
  process.exit(1);
});

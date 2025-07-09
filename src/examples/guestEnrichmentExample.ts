/**
 * Example demonstrating Guest Enrichment functionality
 * 
 * This example shows how the guest enrichment service:
 * 1. Extracts guest names from episode metadata
 * 2. Uses Perplexity AI to fetch biographical information
 * 3. Updates episode records with enriched guest data
 * 4. Integrates seamlessly with the episode processing pipeline
 */

import { RDSService } from '../lib/rdsService.js';
import { GuestEnrichmentService } from '../lib/guestEnrichmentService.js';
import { VideoMetadata } from '../types.js';

// Example function demonstrating guest enrichment workflow
export async function exampleGuestEnrichment() {
  // Sample video metadata for an episode with guests
  const sampleVideoMetadata: VideoMetadata = {
    title: "Building the Future of AI with Elon Musk and Sam Altman",
    uploader: "Tech Talk Podcast",
    id: "episode_with_guests_123",
    duration: 3600, // 60 minutes
    description: "In this episode, we sit down with Elon Musk, CEO of Tesla and SpaceX, and Sam Altman, CEO of OpenAI, to discuss the future of artificial intelligence, entrepreneurship, and space exploration. Join host Sarah Chen as she explores the minds behind some of the most innovative companies of our time.",
    upload_date: "20240315",
    view_count: 250000,
    like_count: 8500,
    webpage_url: "https://www.youtube.com/watch?v=example_with_guests",
    extractor: "youtube",
    extractor_key: "Youtube",
    thumbnail: "https://img.youtube.com/vi/example_with_guests/maxresdefault.jpg",
    thumbnails: [
      {
        url: "https://img.youtube.com/vi/example_with_guests/maxresdefault.jpg",
        id: "maxresdefault"
      }
    ],
    formats: [],
    age_limit: 0
  };

  // Sample SQS message with channel info
  const sqsMessage = {
    channelId: "UC_tech_talk_podcast",
    channelName: "Tech Talk Podcast",
    hostName: "Sarah Chen",
    hostDescription: "Technology journalist and podcast host with 10+ years of experience covering AI and startups",
    country: "USA",
    genre: "Technology",
    rssUrl: "https://feeds.example.com/tech-talk-podcast.xml",
    // Note: guests will be extracted from metadata, or could be provided here
    guests: [], // Will be auto-extracted or manually provided
    guestDescriptions: [], // Will be enriched by AI
    topics: ["AI", "Technology", "Entrepreneurship", "Space"],
    channelDescription: "Weekly conversations with tech leaders and innovators",
    channelThumbnail: "https://example.com/channel-thumb.jpg",
    subscriberCount: 150000,
    verified: true
  };

  console.log('🚀 Starting Guest Enrichment Example...');
  console.log('=====================================\n');

  // Step 1: Test guest name extraction
  console.log('📝 Step 1: Extracting guest names from metadata');
  console.log('-----------------------------------------------');
  
  const extractedGuests = await GuestEnrichmentService.extractGuestNamesFromMetadata(
    sampleVideoMetadata.title,
    sampleVideoMetadata.description
  );
  
  console.log(`Episode Title: "${sampleVideoMetadata.title}"`);
  console.log(`Episode Description: "${sampleVideoMetadata.description.substring(0, 100)}..."`);
  console.log(`\n✅ Extracted Guests: ${JSON.stringify(extractedGuests, null, 2)}\n`);

  // Step 2: Test individual guest enrichment
  console.log('🔍 Step 2: Testing individual guest enrichment');
  console.log('----------------------------------------------');
  
  const guestEnrichmentService = new GuestEnrichmentService();
  
  if (guestEnrichmentService.isAvailable()) {
    console.log('✅ Guest enrichment service is available');
    
    // Test with first extracted guest (if any)
    if (extractedGuests.length > 0) {
      const testGuest = extractedGuests[0];
      console.log(`\n🔍 Enriching guest: ${testGuest}`);
      
      try {
        const enrichmentResult = await guestEnrichmentService.enrichGuest({
          name: testGuest,
          podcastTitle: sampleVideoMetadata.uploader,
          episodeTitle: sampleVideoMetadata.title
        });
        
        console.log(`📊 Enrichment Result:`);
        console.log(JSON.stringify(enrichmentResult, null, 2));
      } catch (error: any) {
        console.log(`❌ Enrichment failed: ${error.message}`);
      }
    } else {
      console.log('⚠️ No guests extracted for individual enrichment test');
    }
  } else {
    console.log('⚠️ Guest enrichment service not available (PPLX_API_KEY not set)');
  }

  // Step 3: Test full episode processing with guest enrichment
  console.log('\n🏗️ Step 3: Testing full episode processing with guest enrichment');
  console.log('=================================================================');

  try {
    const rdsService = new RDSService({
      host: process.env.RDS_HOST || 'localhost',
      user: process.env.RDS_USER || 'postgres',
      password: process.env.RDS_PASSWORD || '',
      database: process.env.RDS_DATABASE || 'postgres',
      port: parseInt(process.env.RDS_PORT || '5432'),
      ssl: process.env.RDS_SSL_ENABLED === 'true' ? { rejectUnauthorized: false } : false,
    });

    const audioS3Link = "https://s3.amazonaws.com/audio-bucket/enriched-episode-audio.mp3";
    
    console.log('📊 Processing episode with guest enrichment...');
    
    const processedEpisode = await rdsService.processEpisodeFromSQS(
      sqsMessage,
      sampleVideoMetadata,
      audioS3Link,
      true // Enable guest enrichment
    );

    console.log('\n✅ Episode processed successfully!');
    console.log('==================================');
    console.log(`Episode ID: ${processedEpisode.episodeId}`);
    console.log(`Episode Title: ${processedEpisode.episodeTitle}`);
    console.log(`Host: ${processedEpisode.hostName}`);
    console.log(`Guests: ${JSON.stringify(processedEpisode.guests, null, 2)}`);
    console.log(`Guest Descriptions: ${JSON.stringify(processedEpisode.guestDescriptions, null, 2)}`);
    
    // Show enrichment metadata if available
    const guestEnrichmentMetadata = processedEpisode.additionalData?.guestEnrichment;
    if (guestEnrichmentMetadata) {
      console.log('\n📊 Guest Enrichment Statistics:');
      console.log('-------------------------------');
      console.log(`Enriched At: ${guestEnrichmentMetadata.enrichedAt}`);
      console.log(`Success Rate: ${guestEnrichmentMetadata.successCount}/${guestEnrichmentMetadata.totalCount}`);
      console.log(`Confidence Distribution:`, guestEnrichmentMetadata.confidenceStats);
    }

  } catch (error: any) {
    console.log(`❌ Episode processing failed: ${error.message}`);
    console.log('This might be due to RDS connection issues or missing environment variables.');
  }

  // Step 4: Manual guest enrichment for existing episode
  console.log('\n🔧 Step 4: Manual guest enrichment for existing episode');
  console.log('========================================================');
  
  console.log('The guest enrichment service can also be used to enrich existing episodes:');
  console.log('```javascript');
  console.log('const rdsService = new RDSService(config);');
  console.log('const enrichedEpisode = await rdsService.enrichGuestInfo("episode_id_here");');
  console.log('```');

  console.log('\n🎯 Guest Enrichment Features:');
  console.log('=============================');
  console.log('• Automatic guest name extraction from episode metadata');
  console.log('• AI-powered biographical information retrieval');
  console.log('• Confidence scoring for enrichment quality');
  console.log('• Batch processing of multiple guests');
  console.log('• Graceful fallback when enrichment fails');
  console.log('• Integration with episode processing pipeline');
  console.log('• Metadata tracking for enrichment statistics');
  
  console.log('\n✅ Guest enrichment example completed! 🎉');
}

// Example of how guest enrichment integrates with the pipeline
export function showGuestEnrichmentIntegration() {
  console.log('\n🔄 Guest Enrichment Pipeline Integration:');
  console.log('=========================================');
  console.log('1. SQS message received with episode URL');
  console.log('2. Video metadata fetched from YouTube');
  console.log('3. Episode created in RDS with basic info');
  console.log('4. 🆕 Guest names extracted from title/description');
  console.log('5. 🆕 AI enrichment fetches guest biographies');
  console.log('6. 🆕 Episode updated with enriched guest data');
  console.log('7. Audio/video processing continues as normal');
  
  console.log('\n📊 Enhanced Episode Data Structure:');
  console.log('===================================');
  console.log(`{
  "episodeId": "...",
  "episodeTitle": "Building the Future with Elon Musk",
  "guests": ["Elon Musk", "Sam Altman"],
  "guestDescriptions": [
    "CEO of Tesla and SpaceX, entrepreneur and innovator in electric vehicles and space exploration",
    "CEO of OpenAI, former president of Y Combinator, leading figure in AI development"
  ],
  "additionalData": {
    "guestEnrichment": {
      "enrichedAt": "2024-03-15T10:30:00Z",
      "successCount": 2,
      "totalCount": 2,
      "confidenceStats": { "high": 2, "medium": 0, "low": 0 }
    }
  }
}`);
}

// Run the example
if (require.main === module) {
  exampleGuestEnrichment().catch(console.error);
}

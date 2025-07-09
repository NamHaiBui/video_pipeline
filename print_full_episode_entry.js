#!/usr/bin/env node
/**
 * Print Full Episode Entry Structure
 * This script shows the complete JSON structure that would be stored in the database
 */

import { config } from 'dotenv';
import { createRDSService } from './dist/lib/rdsService.js';
import { GuestEnrichmentService } from './dist/lib/guestEnrichmentService.js';
import { TopicEnrichmentService } from './dist/lib/topicEnrichmentService.js';

// Load environment variables
config();

async function generateFullEpisodeEntry() {
    console.log('🎯 Generating Full Episode Entry Structure');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    
    // Test episode data
    const episodeData = {
        title: "The Future of AI with Sam Altman and Elon Musk",
        description: "A deep dive into artificial intelligence, AGI development, and the future of technology with OpenAI CEO Sam Altman and Tesla/SpaceX founder Elon Musk.",
        url: "https://test-video-url.com/ai-future-2024",
        thumbnailUrl: "https://test-thumbnail.com/ai-future.jpg",
        duration: 7200, // 2 hours
        publishedAt: new Date('2024-01-15'),
        channel: {
            id: "test-tech-channel-123",
            name: "Tech Talk Podcast",
            description: "Leading conversations in technology and innovation",
            genre: "Technology"
        }
    };
    
    const rdsService = createRDSService();
    
    // Step 1: Create SQS message and metadata
    const sqsMessage = {
        videoId: `episode_${Date.now()}`,
        episodeTitle: episodeData.title,
        channelName: episodeData.channel.name,
        channelId: episodeData.channel.id,
        originalUri: episodeData.url,
        publishedDate: episodeData.publishedAt.toISOString(),
        contentType: 'Video',
        hostName: 'Tech Podcast Host',
        hostDescription: 'Leading technology podcast host',
        genre: episodeData.channel.genre,
        country: 'USA',
        websiteLink: episodeData.url,
        additionalData: {
            youtubeVideoId: `episode_${Date.now()}`,
            youtubeChannelId: episodeData.channel.id,
            youtubeUrl: episodeData.url,
            notificationReceived: new Date().toISOString(),
            channelDescription: episodeData.channel.description,
            verified: true,
            subscriberCount: 125000
        }
    };
    
    const episodeMetadata = {
        id: sqsMessage.videoId,
        title: episodeData.title,
        description: episodeData.description,
        duration: episodeData.duration,
        upload_date: episodeData.publishedAt.toISOString().split('T')[0].replace(/-/g, ''),
        thumbnail: episodeData.thumbnailUrl,
        uploader: episodeData.channel.name,
        view_count: 85432,
        like_count: 3245,
        webpage_url: episodeData.url,
        extractor: 'youtube'
    };
    
    // Step 2: Process episode metadata
    const episodeInput = rdsService.processEpisodeMetadata(episodeMetadata, 'https://s3.amazonaws.com/bucket/audio.mp3', sqsMessage);
    
    // Step 3: Extract and enrich guests
    console.log('🔍 Extracting and enriching guests...');
    const extractedGuests = await GuestEnrichmentService.extractGuestNamesFromMetadata(
        episodeInput.episodeTitle,
        episodeInput.episodeDescription,
        episodeInput.hostName,
        episodeInput.channelName
    );
    
    let enrichedGuests = [];
    if (extractedGuests.length > 0) {
        const guestInputs = extractedGuests.map(name => ({
            name,
            podcastTitle: episodeInput.channelName,
            episodeTitle: episodeInput.episodeTitle
        }));
        
        const guestEnrichmentService = new GuestEnrichmentService();
        const enrichmentResults = await guestEnrichmentService.enrichGuests(guestInputs);
        enrichedGuests = enrichmentResults.filter(result => result.status === 'success');
    }
    
    // Step 4: Enrich topics
    console.log('🔍 Enriching topics...');
    const topicEnrichmentService = new TopicEnrichmentService();
    const topicInput = {
        episodeTitle: episodeInput.episodeTitle,
        episodeDescription: episodeInput.episodeDescription,
        channelName: episodeInput.channelName,
        hostName: episodeInput.hostName,
        guests: enrichedGuests.map(g => g.name)
    };
    
    const topicResult = await topicEnrichmentService.enrichTopics(topicInput);
    
    // Step 5: Create the complete episode entry
    const completeEpisodeEntry = {
        // Basic Episode Information
        episodeId: episodeInput.episodeId,
        episodeTitle: episodeInput.episodeTitle,
        episodeDescription: episodeInput.episodeDescription,
        slug: episodeInput.episodeTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
        
        // Host and Channel Information
        hostName: episodeInput.hostName,
        hostDescription: episodeInput.hostDescription,
        channelName: episodeInput.channelName,
        channelId: episodeInput.channelId,
        country: episodeInput.country,
        genre: episodeInput.genre,
        
        // Media and URLs
        episodeUri: episodeInput.episodeUri, // S3 audio/video URL
        originalUri: episodeInput.originalUri, // Original YouTube URL
        episodeImages: episodeInput.episodeImages, // Thumbnail images
        guestImageUrl: null,
        
        // Timing and Metadata
        publishedDate: episodeInput.publishedDate,
        durationMillis: episodeInput.durationMillis,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        
        // Content Type
        contentType: episodeInput.contentType, // Always 'Video'
        
        // Enriched Guest Information
        guests: enrichedGuests.map(guest => guest.name),
        guestDescriptions: enrichedGuests.map(guest => guest.description),
        
        // Enriched Topic Information  
        topics: topicResult.status === 'success' ? topicResult.topics : [],
        
        // Processing Information
        processingInfo: {
            episodeTranscribingDone: false,
            summaryTranscribingDone: false,
            summarizingDone: false,
            numChunks: 0,
            numRemovedChunks: 0,
            chunkingDone: false,
            quotingDone: false
        },
        
        // Processing Status
        processingDone: false,
        isSynced: false,
        
        // URLs for processed content (initially empty)
        rssUrl: null,
        transcriptUri: null,
        processedTranscriptUri: null,
        summaryAudioUri: null,
        summaryDurationMillis: 0,
        summaryTranscriptUri: null,
        
        // Additional Data
        additionalData: {
            ...episodeInput.additionalData,
            
            // Guest enrichment metadata
            guestEnrichment: {
                enrichedAt: new Date().toISOString(),
                method: 'openai_extraction_perplexity_enrichment',
                successCount: enrichedGuests.length,
                totalCount: extractedGuests.length,
                confidenceStats: {
                    high: enrichedGuests.filter(g => g.confidence === 'high').length,
                    medium: enrichedGuests.filter(g => g.confidence === 'medium').length,
                    low: enrichedGuests.filter(g => g.confidence === 'low').length
                }
            },
            
            // Topic enrichment metadata
            topicEnrichment: {
                enrichedAt: new Date().toISOString(),
                method: 'perplexity_llm',
                confidence: topicResult.confidence || 'none',
                topicCount: topicResult.status === 'success' ? topicResult.topics.length : 0,
                status: topicResult.status
            },
            
            // Original video metadata
            originalVideoMetadata: {
                viewCount: episodeMetadata.view_count,
                likeCount: episodeMetadata.like_count,
                uploader: episodeMetadata.uploader,
                extractor: episodeMetadata.extractor,
                uploadDate: episodeMetadata.upload_date
            }
        }
    };
    
    // Print the complete structure
    console.log('\\n📋 Complete Episode Entry Structure:');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(JSON.stringify(completeEpisodeEntry, null, 2));
    
    console.log('\\n📊 Entry Summary:');
    console.log(`   • Episode ID: ${completeEpisodeEntry.episodeId}`);
    console.log(`   • Title: ${completeEpisodeEntry.episodeTitle}`);
    console.log(`   • Channel: ${completeEpisodeEntry.channelName} (${completeEpisodeEntry.genre})`);
    console.log(`   • Duration: ${Math.floor(completeEpisodeEntry.durationMillis / 60000)} minutes`);
    console.log(`   • Content Type: ${completeEpisodeEntry.contentType}`);
    console.log(`   • Guests: ${completeEpisodeEntry.guests.length} enriched`);
    console.log(`   • Topics: ${completeEpisodeEntry.topics.length} generated`);
    console.log(`   • Episode Images: ${completeEpisodeEntry.episodeImages.length}`);
    console.log(`   • Processing Done: ${completeEpisodeEntry.processingDone}`);
    console.log(`   • Synced: ${completeEpisodeEntry.isSynced}`);
    
    return completeEpisodeEntry;
}

// Run the generator
generateFullEpisodeEntry().catch(error => {
    console.error('Failed to generate episode entry:', error);
    process.exit(1);
});

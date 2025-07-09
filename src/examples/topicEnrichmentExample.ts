/**
 * Topic Enrichment Example
 * 
 * This example demonstrates how to use the Topic Enrichment Service
 * to extract main topics and themes from podcast episodes using AI.
 */

import dotenv from 'dotenv';
import { logger } from '../lib/logger.js';
import { TopicEnrichmentService, TopicEnrichmentInput } from '../lib/topicEnrichmentService.js';
import { enrichExistingEpisodeTopics, batchEnrichEpisodeTopics } from '../lib/ytdlpWrapper.js';

// Load environment variables
dotenv.config();

async function runTopicEnrichmentExample() {
  logger.info('🚀 Starting Topic Enrichment Service Example');
  
  // Initialize the service
  const topicService = new TopicEnrichmentService();
  
  // Check if service is available
  if (!topicService.isAvailable()) {
    logger.warn('⚠️ Topic enrichment service not available (check PERPLEXITY_KEY)');
    
    // Demonstrate fallback topic generation
    logger.info('📝 Demonstrating fallback topic generation...');
    
    const fallbackInput: TopicEnrichmentInput = {
      episodeTitle: "Building a Successful Tech Startup with AI and Machine Learning",
      episodeDescription: "In this episode, we discuss the journey of building a successful tech startup, focusing on AI and machine learning technologies, fundraising strategies, and scaling challenges.",
      channelName: "Tech Entrepreneur Podcast",
      hostName: "Sarah Johnson",
      guests: ["Dr. Michael Chen", "Alex Rodriguez"]
    };
    
    const fallbackTopics = topicService.generateFallbackTopics(fallbackInput);
    logger.info('🏷️ Fallback topics generated:', { topics: fallbackTopics });
    
    return;
  }
  
  logger.info('✅ Topic enrichment service is available');
  
  // Example 1: Single episode topic enrichment
  logger.info('\n📝 Example 1: Single Episode Topic Enrichment');
  
  const singleEpisodeInput: TopicEnrichmentInput = {
    episodeTitle: "The Future of AI in Healthcare: Transforming Patient Care",
    episodeDescription: "Dr. Sarah Martinez discusses how artificial intelligence is revolutionizing healthcare, from diagnostic tools to personalized treatment plans. We explore current applications, ethical considerations, and the future of AI-powered medicine.",
    channelName: "Healthcare Innovation Podcast",
    hostName: "Dr. John Smith",
    guests: ["Dr. Sarah Martinez", "Tech Analyst Kevin Liu"]
  };
  
  try {
    const result = await topicService.enrichTopics(singleEpisodeInput);
    
    if (result.status === 'success') {
      logger.info('✅ Successfully enriched topics:', {
        topics: result.topics,
        confidence: result.confidence,
        count: result.topics.length
      });
    } else {
      logger.error(`❌ Topic enrichment failed: ${result.errorMessage}`);
    }
  } catch (error: any) {
    logger.error('❌ Error during topic enrichment:', error);
  }
  
  // Example 2: Batch topic enrichment
  logger.info('\n📦 Example 2: Batch Topic Enrichment');
  
  const batchInputs: TopicEnrichmentInput[] = [
    {
      episodeTitle: "Cryptocurrency and the Future of Finance",
      episodeDescription: "Exploring blockchain technology, digital currencies, and decentralized finance",
      channelName: "FinTech Today",
      hostName: "Amanda Wilson",
      guests: ["Bitcoin Expert Mike Johnson"]
    },
    {
      episodeTitle: "Sustainable Energy Solutions for Climate Change",
      episodeDescription: "Renewable energy technologies, solar power innovations, and environmental impact",
      channelName: "Green Tech Podcast",
      hostName: "Dr. Lisa Chen",
      guests: ["Solar Engineer Tom Davis"]
    },
    {
      episodeTitle: "The Art of Remote Team Management",
      episodeDescription: "Best practices for managing distributed teams, communication tools, and productivity",
      channelName: "Leadership Insights",
      hostName: "Michael Torres"
    }
  ];
  
  try {
    const batchResults = await topicService.batchEnrichTopics(batchInputs);
    
    batchResults.forEach((result, index) => {
      const input = batchInputs[index];
      if (result.status === 'success') {
        logger.info(`✅ Episode ${index + 1} topics:`, result.topics);
        logger.debug(`Episode details:`, {
          episode: input.episodeTitle.substring(0, 50) + '...',
          confidence: result.confidence
        });
      } else {
        logger.error(`❌ Episode ${index + 1} failed: ${result.errorMessage}`);
      }
    });
    
    const successful = batchResults.filter(r => r.status === 'success').length;
    logger.info(`📊 Batch enrichment summary: ${successful}/${batchResults.length} successful`);
    
  } catch (error: any) {
    logger.error('❌ Error during batch topic enrichment:', error);
  }
  
  // Example 3: Episode-based topic enrichment (requires existing episode in DB)
  logger.info('\n🗃️ Example 3: Episode-based Topic Enrichment');
  logger.info('This would enrich topics for an existing episode in the database');
  logger.info('To test this, replace "example-episode-id" with a real episode ID from your RDS database');
  
  // Uncomment and replace with a real episode ID to test:
  /*
  try {
    const episodeId = "example-episode-id";
    const enrichedEpisode = await enrichExistingEpisodeTopics(episodeId);
    
    if (enrichedEpisode) {
      logger.info('✅ Successfully enriched episode topics:', {
        episodeId: enrichedEpisode.episodeId,
        title: enrichedEpisode.episodeTitle,
        topics: enrichedEpisode.topics,
        topicCount: enrichedEpisode.topics?.length || 0
      });
    } else {
      logger.warn('⚠️ Failed to enrich episode topics');
    }
  } catch (error: any) {
    logger.error('❌ Error enriching episode topics:', error);
  }
  */
  
  logger.info('🎉 Topic enrichment example completed!');
}

// Run the example
runTopicEnrichmentExample().catch(error => {
  logger.error('💥 Topic enrichment example failed:', error);
  process.exit(1);
});

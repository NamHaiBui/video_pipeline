/**
 * Example usage of Episode Processing with RDS
 * 
 * This example demonstrates how the new RDS-based episode processing:
 * 1. Creates episodes with embedded channel information
 * 2. Uses the new Episode table schema
 * 3. Processes episode data matching the PostgreSQL structure
 */

import { RDSService } from '../lib/rdsService.js';
import { VideoMetadata } from '../types.js';

// Example function demonstrating the new RDS episode processing workflow
export async function exampleEpisodeProcessingWithRDS() {
  const rdsService = new RDSService({
    host: process.env.RDS_HOST || 'localhost',
    user: process.env.RDS_USER || 'postgres',
    password: process.env.RDS_PASSWORD || '',
    database: process.env.RDS_DATABASE || 'postgres',
    port: parseInt(process.env.RDS_PORT || '5432'),
    ssl: process.env.RDS_SSL_ENABLED === 'true' ? { rejectUnauthorized: false } : false,
  });

  // Sample video metadata (as would come from yt-dlp)
  const sampleVideoMetadata: VideoMetadata = {
    title: "All-In E211: OpenAI's GPT Store, Amazon's AI bet, State of the 2024 presidential race",
    uploader: "All-In Podcast",
    id: "video123",
    duration: 5400, // 90 minutes
    description: "The All-In crew discusses the latest in AI, business, and politics...",
    upload_date: "20240115",
    view_count: 125000,
    like_count: 3500,
    webpage_url: "https://www.youtube.com/watch?v=video123",
    extractor: "youtube",
    extractor_key: "Youtube",
    thumbnail: "https://img.youtube.com/vi/video123/maxresdefault.jpg",
    thumbnails: [
      {
        url: "https://img.youtube.com/vi/video123/maxresdefault.jpg",
        id: "maxresdefault"
      }
    ],
    formats: [],
    age_limit: 0
  };

  // Sample channel information (as would come from SQS message - matches new Episode schema)
  const channelInfo = {
    channelId: "UC4CRUTGaG2_lSHM05Q4uVKQ", // All-In Podcast channel
    channelName: "All-In Podcast",
    hostName: "Jason Calacanis, Chamath Palihapitiya, David Sacks, David Friedberg",
    hostDescription: "Four experienced investors and entrepreneurs discussing business, tech, and politics",
    country: "USA",
    genre: "Business", // genreId from SQS will be passed as 'genre'
    rssUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UC4CRUTGaG2_lSHM05Q4uVKQ",
    guests: ["Elon Musk", "Other Guest"], // Example guest names
    guestDescriptions: ["CEO of Tesla and SpaceX", "Description of other guest"],
    guestImageUrl: "https://example.com/guest-image.jpg",
    episodeImages: ["https://img.youtube.com/vi/video123/maxresdefault.jpg"],
    topics: ["AI", "Business", "Politics", "Technology"],
    channelDescription: "All-In Podcast brings you the unvarnished truth about what's happening in the world of business and tech.",
    channelThumbnail: "https://yt3.googleusercontent.com/channel-thumbnail.jpg",
    subscriberCount: 750000,
    verified: true
  };

  console.log('🚀 Starting RDS episode processing example...');

  try {
    // Step 1: Create a new episode record with all required fields from the new schema
    const episodeId = `episode_${Date.now()}`;
    const currentDate = new Date();

    const newEpisodeData = {
      episodeId: episodeId,
      episodeTitle: sampleVideoMetadata.title,
      episodeDescription: sampleVideoMetadata.description || '',
      channelName: channelInfo.channelName,
      hostName: channelInfo.hostName,
      hostDescription: channelInfo.hostDescription,
      guests: channelInfo.guests || [],
      guestDescriptions: channelInfo.guestDescriptions || [],
      guestImageUrl: channelInfo.guestImageUrl,
      originalUri: sampleVideoMetadata.webpage_url,
      channelId: channelInfo.channelId,
      country: channelInfo.country,
      genre: channelInfo.genre,
      durationMillis: sampleVideoMetadata.duration ? sampleVideoMetadata.duration * 1000 : 0,
      publishedDate: parseUploadDate(sampleVideoMetadata.upload_date) || currentDate,
      contentType: 'Audio' as const,
      rssUrl: channelInfo.rssUrl,
      episodeImages: channelInfo.episodeImages || [sampleVideoMetadata.thumbnail],
      transcriptUri: '', // Will be populated during processing
      processedTranscriptUri: '', // Will be populated during processing
      summaryAudioUri: '', // Will be populated during processing
      summaryDurationMillis: 0, // Will be populated during processing
      summaryTranscriptUri: '', // Will be populated during processing
      topics: channelInfo.topics || [], // Populated from SQS or by AI analysis
      processingInfo: {
        episodeTranscribingDone: false,
        summaryTranscribingDone: false,
        summarizingDone: false,
        numChunks: 0,
        numRemovedChunks: 0,
        chunkingDone: false,
        quotingDone: false
      },
      additionalData: {
        viewCount: sampleVideoMetadata.view_count,
        likeCount: sampleVideoMetadata.like_count,
        originalVideoId: sampleVideoMetadata.id,
        channelInfo: {
          channelDescription: channelInfo.channelDescription,
          channelThumbnail: channelInfo.channelThumbnail,
          subscriberCount: channelInfo.subscriberCount,
          verified: channelInfo.verified
        }
      },
      processingDone: false,
      isSynced: false
    };

    console.log(`📝 Creating episode: ${newEpisodeData.episodeTitle}`);
    const createdEpisode = await rdsService.createEpisode(newEpisodeData);

    if (createdEpisode) {
      console.log('✅ Episode created successfully:', {
        episodeId: createdEpisode.episodeId,
        title: createdEpisode.episodeTitle,
        channelName: createdEpisode.channelName,
        genre: createdEpisode.genre,
        duration: `${Math.round(createdEpisode.durationMillis / 60000)} minutes`
      });

      // Step 2: Simulate processing updates
      console.log('\n🔄 Simulating episode processing updates...');
      
      // Update 1: Transcription completed
      await rdsService.updateEpisode(episodeId, {
        processingInfo: {
          ...createdEpisode.processingInfo,
          episodeTranscribingDone: true,
          numChunks: 45
        },
        transcriptUri: `s3://transcripts/${episodeId}/transcript.txt`
      });
      console.log('✅ Transcription completed');

      // Update 2: Summary processing
      await rdsService.updateEpisode(episodeId, {
        processingInfo: {
          ...createdEpisode.processingInfo,
          episodeTranscribingDone: true,
          summaryTranscribingDone: true,
          summarizingDone: true,
          numChunks: 45
        },
        summaryAudioUri: `s3://summaries/${episodeId}/summary.mp3`,
        summaryDurationMillis: 900000, // 15 minutes
        summaryTranscriptUri: `s3://summaries/${episodeId}/summary.txt`,
        topics: ['AI', 'Business', 'Technology', 'Politics']
      });
      console.log('✅ Summary processing completed');

      // Update 3: All processing complete
      await rdsService.updateEpisode(episodeId, {
        processingInfo: {
          ...createdEpisode.processingInfo,
          episodeTranscribingDone: true,
          summaryTranscribingDone: true,
          summarizingDone: true,
          chunkingDone: true,
          quotingDone: true,
          numChunks: 45
        },
        processingDone: true,
        isSynced: true
      });
      console.log('✅ All processing completed');

      // Step 3: Retrieve and display final episode
      const finalEpisode = await rdsService.getEpisode(episodeId);
      console.log('\n📊 Final episode data:', {
        episodeId: finalEpisode?.episodeId,
        title: finalEpisode?.episodeTitle,
        processingDone: finalEpisode?.processingDone,
        topics: finalEpisode?.topics,
        summaryDuration: finalEpisode?.summaryDurationMillis ? `${Math.round(finalEpisode.summaryDurationMillis / 60000)} minutes` : 'N/A'
      });

    } else {
      console.log('❌ Failed to create episode');
    }

  } catch (error) {
    console.error('❌ Error in episode processing example:', error);
  }
}

// Utility function to parse YouTube upload date
function parseUploadDate(uploadDate: string): Date | null {
  if (!uploadDate) return null;
  
  try {
    // Handle YouTube date format (YYYYMMDD)
    if (/^\d{8}$/.test(uploadDate)) {
      const year = uploadDate.substring(0, 4);
      const month = uploadDate.substring(4, 6);
      const day = uploadDate.substring(6, 8);
      return new Date(`${year}-${month}-${day}`);
    }
    
    return new Date(uploadDate);
  } catch (error) {
    console.error(`Failed to parse upload date: ${uploadDate}`, error);
    return null;
  }
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('🚀 Running RDS Episode Processing Example...');
  exampleEpisodeProcessingWithRDS()
    .then(() => {
      console.log('\n✅ Example completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Example failed:', error);
      process.exit(1);
    });
}

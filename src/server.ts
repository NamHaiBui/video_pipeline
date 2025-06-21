import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { 
  DownloadJob, 
  DownloadRequest, 
  DownloadResponse, 
  JobStatusResponse,
  ProgressInfo, 
  VideoMetadata,
  AnalysisConfig
} from './types.js';
import { 
  getVideoMetadata,
  downloadAndMergeVideo
} from './lib/ytdlpWrapper.js';
import { isValidYouTubeUrl, sanitizeYouTubeUrl } from './lib/urlUtils.js';
import { checkAndUpdateYtdlp, getUpdateStatus, UpdateOptions } from './lib/update_ytdlp.js';
import { createS3ServiceFromEnv, S3Service } from './lib/s3Service.js';
import { createSQSServiceFromEnv, SQSService } from './lib/sqsService.js';
import { logger } from './lib/logger.js';
import { DynamoDBService } from './lib/dynamoService.js';
import { create_slug } from './lib/utils/utils.js';

import dotenv from 'dotenv';

// Load environment configuration
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Initialize S3 service
const s3Service = createS3ServiceFromEnv();
const isS3Enabled = s3Service !== null && process.env.S3_UPLOAD_ENABLED === 'true';

// Initialize SQS service
const sqsService = createSQSServiceFromEnv();
const isSQSEnabled = sqsService !== null;

// Initialize DynamoDB service
const dynamoService = new DynamoDBService({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  podcastEpisodesTableName: process.env.DYNAMODB_PODCAST_EPISODES_TABLE || 'PodcastEpisodeStoreTest'
});

const isDynamoEnabled = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

const isPodcastConversionEnabled = process.env.PODCAST_CONVERSION_ENABLED !== 'false';

if (isS3Enabled) {
  logger.info('S3 upload service initialized successfully');
} else {
  logger.warn('S3 upload service disabled or not configured');
}

if (isSQSEnabled) {
  logger.info('SQS service initialized successfully');
} else {
  logger.warn('SQS service disabled or not configured');
}

if (isDynamoEnabled) {
  logger.info('DynamoDB service initialized successfully');
} else {
  logger.warn('DynamoDB service disabled or not configured');
}

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for download jobs
const downloadJobs = new Map<string, DownloadJob>();

// Serve static files from downloads directory
const downloadsDir = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Add temp directory setup
const tempDir = path.resolve(process.cwd(), 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

app.use('/downloads', express.static(downloadsDir));

/**
 * POST /api/download
 * Starts a new download job for video with merged audio
 */
app.post('/api/download', async (req: Request<{}, {}, DownloadRequest>, res: Response<DownloadResponse>) => {
  try {
    const { url } = req.body;

    if (!url) {
      res.status(400).json({
        success: false,
        jobId: '',
        message: 'URL is required'
      });
      return;
    }
    if (!isValidYouTubeUrl(url)) {
      res.status(400).json({
        success: false,
        jobId: '',
        message: 'Invalid YouTube URL provided'
      });
      return;
    }

    const sanitizedUrl = sanitizeYouTubeUrl(url);
    const jobId = uuidv4();

    // Create download job
    const job: DownloadJob = {
      id: jobId,
      url: sanitizedUrl,
      status: 'pending',
      progress: {},
      createdAt: new Date()
    };

    downloadJobs.set(jobId, job);

    // Start downloads asynchronously
    processDownload(jobId, sanitizedUrl);

    res.json({
      success: true,
      jobId,
      message: 'Download job started successfully'
    });
  } catch (error) {
    console.error('Error starting download:', error);
    res.status(500).json({
      success: false,
      jobId: '', // Adding jobId to match the DownloadResponse type
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /api/job/:jobId
 * Get the status of a download job
 */
app.get('/api/job/:jobId', (req: Request<{ jobId: string }>, res: Response<JobStatusResponse>) => {
  const { jobId } = req.params;
  
  const job = downloadJobs.get(jobId);
  
  if (!job) {
    res.status(404).json({
      success: false,
      message: 'Job not found'
    });
    return; 
  }

  res.json({
    success: true,
    job,
    message: 'Job status retrieved successfully'
  });
});

/**
 * GET /api/jobs
 * Get all download jobs
 */
app.get('/api/jobs', (req: Request, res: Response) => {
  const jobs = Array.from(downloadJobs.values()).sort((a, b) => 
    b.createdAt.getTime() - a.createdAt.getTime()
  );
  res.json({
    success: true,
    jobs,
    message: 'Jobs retrieved successfully'
  });
});

/**
 * DELETE /api/job/:jobId
 * Delete a download job
 */
app.delete('/api/job/:jobId', (req: Request<{ jobId: string }>, res: Response) => {
  const { jobId } = req.params;
  
  if (downloadJobs.delete(jobId)) {
    res.json({
      success: true,
      message: 'Job deleted successfully'
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'Job not found'
    });
  }
});
app.get('/api/search/:query', async (req: Request<{ query: string }>, res: Response) => {
  try {
    const { query } = req.params;
    const { maxResults = '10' } = req.query;

    if (!YOUTUBE_API_KEY) {
      res.status(500).json({
        success: false,
        message: 'YouTube API key not configured'
      });
      return;
    }

    if (!query.trim()) {
      res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
      return;
    }

    const searchResults = await searchYouTubeVideos(query, parseInt(maxResults as string));
    
    res.json({
      success: true,
      results: searchResults,
      message: 'Search completed successfully'
    });

  } catch (error) {
    console.error('Error searching YouTube:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Search failed'
    });
  }
});
/**
 * Search YouTube videos with filters for duration and relevance
 */
async function searchYouTubeVideos(query: string, maxResults: number = 10): Promise<Record<string, string>> {
  try {
    // Search for more videos than needed to account for filtering
    const searchCount = Math.max(maxResults * 2, 15);
    
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.append('part', 'snippet');
    searchUrl.searchParams.append('q', query);
    searchUrl.searchParams.append('order', 'relevance');
    searchUrl.searchParams.append('maxResults', searchCount.toString());
    searchUrl.searchParams.append('type', 'video');
    searchUrl.searchParams.append('key', YOUTUBE_API_KEY!);
    
    console.log(`Fetching YouTube search results from: ${searchUrl.toString()}`);

    const response = await fetch(searchUrl.toString());
    console.log(`YouTube API response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`YouTube API error response: ${errorText}`);
      throw new Error(`YouTube API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const searchData = await response.json() as any;
    
    if (!searchData.items || searchData.items.length === 0) {
      console.log('No search results found');
      return {};
    }

    // Get video IDs for duration filtering
    const videoIds = searchData.items.map((item: any) => item.id.videoId).join(',');
    
    // Fetch video details to get duration
    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.searchParams.append('part', 'contentDetails,snippet');
    detailsUrl.searchParams.append('id', videoIds);
    detailsUrl.searchParams.append('key', YOUTUBE_API_KEY!);

    const detailsResponse = await fetch(detailsUrl.toString());
    
    if (!detailsResponse.ok) {
      const errorText = await detailsResponse.text();
      console.error(`YouTube videos API error: ${errorText}`);
      throw new Error(`YouTube videos API error: ${detailsResponse.status} ${detailsResponse.statusText}`);
    }

    const detailsData = await detailsResponse.json() as any; // This is really bad but this is a future implementation

    
    const results: Record<string, string> = {};
    let count = 0;

    for (const video of detailsData.items) {
      if (count >= maxResults) break;

      const duration = video.contentDetails.duration;
      const durationInSeconds = parseDuration(duration);
      
      if (durationInSeconds > 240) {
        const title = video.snippet.title;
        const videoId = video.id;
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        results[title] = url;
        count++;
        
        console.log(`Added video: ${title} (${Math.floor(durationInSeconds / 60)}:${(durationInSeconds % 60).toString().padStart(2, '0')})`);
      } else {
        console.log(`Skipped video (too short): ${video.snippet.title} (${Math.floor(durationInSeconds / 60)}:${(durationInSeconds % 60).toString().padStart(2, '0')})`);
      }
    }

    console.log(`Found ${Object.keys(results).length} search results longer than 4 minutes`);
    return results;

  } catch (error) {
    console.error('Error in searchYouTubeVideos:', error);
    throw error;
  }
}

/**
 * Parse ISO 8601 duration format (PT1M30S) to seconds
 */
function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Helper function to persist job updates to in-memory storage only
 */
async function persistJobUpdate(jobId: string, job: DownloadJob): Promise<void> {
  // Update in-memory storage
  downloadJobs.set(jobId, { ...job });
}

/**
 * Process download job asynchronously with video+audio merge
 * Exported for use by worker service
 */
export async function processDownload(jobId: string, url: string): Promise<void> {
  let job = downloadJobs.get(jobId);
  if (!job) {
    logger.warn(`Job ${jobId} not found at the start of processDownload. Creating new job entry.`);
    job = {
      id: jobId,
      url: url,
      status: 'pending',
      progress: {},
      createdAt: new Date()
    };
    downloadJobs.set(jobId, job);
  }

  try {
    // 1. Fetch Metadata
    job.status = 'downloading_metadata';
    if (!job.progress) {
        job.progress = {};
    }
    await persistJobUpdate(jobId, job);
    console.log(`Job ${jobId}: Status changed to 'downloading_metadata'. Fetching metadata for ${url}`);

    let metadata: VideoMetadata;
    try {
      metadata = await getVideoMetadata(url);
      
      job = downloadJobs.get(jobId); 
      if (!job) {
        console.warn(`Job ${jobId} was deleted during metadata fetch.`);
        return;
      }
      job.metadata = metadata;
      await persistJobUpdate(jobId, job);
      
      // Save metadata to file
      const metadataFilename = `${jobId}_metadata.json`;
      const metadataPath = path.join(downloadsDir, metadataFilename);
      
      try {
        await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        console.log(`Job ${jobId}: Metadata saved to ${metadataPath}`);
        
        if (!job.filePaths) job.filePaths = {};
        job.filePaths.metadataPath = metadataFilename;
      } catch (writeError: any) {
        console.error(`Job ${jobId}: Failed to save metadata file:`, writeError);
      }
      console.log(`Job ${jobId}: Metadata fetched successfully.`);
    } catch (metaError: any) {
      console.error(`Job ${jobId}: Failed to fetch metadata:`, metaError);
      job = downloadJobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = `Failed to fetch metadata: ${metaError?.message || String(metaError)}`;
        job.completedAt = new Date();
        await persistJobUpdate(jobId, job);
      }
      return; 
    }

    // 2. Start Video Download with Merge
    job = downloadJobs.get(jobId);
    if (!job || job.status === 'error') { 
        console.warn(`Job ${jobId} not found or in error state before starting downloads.`);
        return;
    }
    
    job.status = 'downloading';
    if (!job.filePaths) job.filePaths = {};
    if (!job.progress) job.progress = {}; 
    await persistJobUpdate(jobId, job);
    console.log(`Job ${jobId}: Status changed to 'downloading'. Starting video+audio download and merge.`);

    // Generate output filename using metadata with slug-based naming
    let outputFilename = 'unknown-podcast/untitled-episode.mp4';
    if (metadata) {
      // Create slug-based filename structure
      const podcastSlug = create_slug(metadata.uploader || 'unknown');
      const episodeSlug = create_slug(metadata.title || 'untitled');
      outputFilename = `${podcastSlug}/${episodeSlug}.mp4`;
    }

    try {
      // Use the new merged download function
      const {mergedFilePath, episodeId} = await downloadAndMergeVideo(url, {
        outputDir: downloadsDir,
        outputFilename: outputFilename,
        s3Upload: { 
          enabled: isS3Enabled,
          deleteLocalAfterUpload: true // Clean up files after S3 upload
        },
        onProgress: (progressInfo: ProgressInfo) => {
          const currentJobState = downloadJobs.get(jobId);
          if (currentJobState) {
            if (!currentJobState.progress) currentJobState.progress = {};
          
            if (progressInfo.raw.startsWith('Video:')) {
              currentJobState.progress.video = {
                ...progressInfo,
                raw: progressInfo.raw.replace('Video: ', '')
              };
            } else if (progressInfo.raw.startsWith('Audio:')) {
              currentJobState.progress.audio = {
                ...progressInfo,
                raw: progressInfo.raw.replace('Audio: ', '')
              };
            } else if (progressInfo.raw.includes('Merging') || progressInfo.raw.includes('merge')) {
              currentJobState.status = 'merging';
              currentJobState.progress.merged = progressInfo;
            } else {
              // General progress update
              currentJobState.progress.merged = progressInfo;
            }
            downloadJobs.set(jobId, { ...currentJobState });
          }
        }
      });

      // Update job with final merged file path
      const finalJobState = downloadJobs.get(jobId);
      if (finalJobState) {
        if (!finalJobState.filePaths) finalJobState.filePaths = {};
        
        // Handle the new return type from downloadAndMergeVideo
        const mergedResult = mergedFilePath as any;
        const finalMergedPath = mergedResult.mergedPath || mergedResult;
        const audioOnlyPath = mergedResult.audioPath;
        const audioS3Info = mergedResult.audioS3Info;
        
        finalJobState.filePaths.mergedPath = path.basename(finalMergedPath); 
        
        // Store audio path if available
        if (audioOnlyPath) {
          finalJobState.filePaths.audioPath = path.basename(audioOnlyPath);
        }
        

        finalJobState.status = 'completed';
        finalJobState.completedAt = new Date();
        
        // Final progress update
        if (!finalJobState.progress) finalJobState.progress = {};
        finalJobState.progress.merged = {
          percent: '100%',
          eta: '0s',
          speed: '',
          raw: isS3Enabled ? 'Download, merge, and S3 upload completed successfully!' : 'Download and merge completed successfully!'
        };
        
        await persistJobUpdate(jobId, finalJobState);
        
        logger.info(`Job ${jobId}: processing completed successfully`, { 
          jobId, 
          mergedFile: finalMergedPath,
          s3Enabled: isS3Enabled 
        });
        console.log(`Job ${jobId}: download and merge completed successfully.`);
        console.log(`Final merged file: ${finalMergedPath}`);
        
        // Check if metadata processing is complete and queue for video trimming if ready
        if (episodeId) {
          logger.info(`Checking video trimming readiness for episode: ${episodeId}`);
          await checkAndQueueVideoTrimming(episodeId);
        } else {
          logger.warn(`No episode ID available for job ${jobId}, skipping video trimming check`);
        }
        
      }

    } catch (downloadError: any) {
      console.error(`Job ${jobId}: Download and merge failed:`, downloadError);
      const errorJobState = downloadJobs.get(jobId);
      if (errorJobState) {
        errorJobState.status = 'error';
        errorJobState.error = `Download and merge failed: ${downloadError?.message || String(downloadError)}`;
        errorJobState.completedAt = new Date();
        await persistJobUpdate(jobId, errorJobState);
      }
    }

  } catch (error: any) {
    console.error(`Overall error in processDownload for job ${jobId}:`, error);
    const criticalFailureJob = downloadJobs.get(jobId);
    if (criticalFailureJob) {
      criticalFailureJob.status = 'error';
      criticalFailureJob.error = (criticalFailureJob.error ? criticalFailureJob.error + '; ' : '') + 
                                 `Critical error: ${error?.message || String(error)}`;
      criticalFailureJob.completedAt = new Date();
      await persistJobUpdate(jobId, criticalFailureJob);
    }
  }
}

// Basic health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'podcast-pipeline',
    timestamp: new Date().toISOString(),
    s3Enabled: isS3Enabled,
    sqsEnabled: isSQSEnabled,
    dynamoEnabled: isDynamoEnabled,
    podcastConversionEnabled: isPodcastConversionEnabled
  });
});

// Manual yt-dlp update endpoint
app.post('/api/update-ytdlp', async (req: Request, res: Response) => {
  try {
    const { nightly = false, force = false } = req.body;
    const options: UpdateOptions = {
      useNightly: nightly,
      forceUpdate: force
    };
    
    console.log(`🔄 Manual yt-dlp update requested via API (${nightly ? 'nightly' : 'stable'}, force: ${force})`);
    const wasUpdated = await checkAndUpdateYtdlp(options);
    
    res.json({
      success: true,
      updated: wasUpdated,
      version: nightly ? 'nightly' : 'stable',
      message: wasUpdated 
        ? `yt-dlp has been updated to the latest ${nightly ? 'nightly' : 'stable'} version` 
        : `yt-dlp is already up to date (${nightly ? 'nightly' : 'stable'})`,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('❌ Manual yt-dlp update failed:', error.message);
    res.status(500).json({
      success: false,
      updated: false,
      message: `Update failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

// Get yt-dlp update status endpoint
app.get('/api/update-status', (req: Request, res: Response) => {
  try {
    const status = getUpdateStatus();
    res.json({
      success: true,
      ...status,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: `Failed to get update status: ${error.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

// Serve a simple API documentation page
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Podcast Processing Pipeline API',
    description: 'Convert YouTube videos to podcast episodes with audio extraction and metadata processing',
    endpoints: {
      'POST /api/download': 'Start podcast processing from YouTube URL',
      'GET /api/job/:jobId': 'Get podcast processing job status',
      'GET /api/jobs': 'Get all podcast processing jobs',
      'DELETE /api/job/:jobId': 'Delete a podcast processing job',
      'GET /api/search/:query': 'Search YouTube videos for podcast content',
      'GET /health': 'Health check',
      'GET /downloads/*': 'Access downloaded podcast files'
    },
    usage: {
      'Start Podcast Processing': 'POST /api/download with { "url": "https://youtube.com/watch?v=..." }',
      'Check Status': 'GET /api/job/{jobId}',
      'List All Jobs': 'GET /api/jobs',
      'Search Podcast Content': 'GET /api/search/{query}?maxResults=10',
      'Update yt-dlp': 'POST /api/update-ytdlp with { "nightly": true/false, "force": true/false }',
      'Update Status': 'GET /api/update-status'
    },
    features: {
      'Podcast Conversion': isPodcastConversionEnabled ? 'Enabled' : 'Disabled',
      'Audio Extraction': 'Always Enabled',
      'S3 Upload': isS3Enabled ? 'Enabled' : 'Disabled',
      'SQS Queue': isSQSEnabled ? 'Enabled' : 'Disabled',
      'DynamoDB Storage': isDynamoEnabled ? 'Enabled' : 'Disabled',
      'Video Trimming Queue': isSQSEnabled ? 'Ready' : 'Disabled'
    }
  });
});

app.use((error: Error, req: Request, res: Response, next: any) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

/**
 * Check if episode metadata indicates all processing is complete
 * and queue message to video trimming SQS queue if ready
 * @param episodeId - Episode ID to check and potentially queue
 */
async function checkAndQueueVideoTrimming(episodeId: string): Promise<void> {
  if (!isDynamoEnabled || !isSQSEnabled) {
    logger.warn('DynamoDB or SQS not enabled, skipping video trimming queue check');
    return;
  }

  const trimQueueUrl = process.env.VIDEO_TRIMMING_QUEUE_URL || 'https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming';

  try {
    // Get episode data from DynamoDB
    const episode = await dynamoService.getPodcastEpisode(episodeId);
    
    if (!episode) {
      logger.warn(`Episode ${episodeId} not found in database, cannot check trimming status`);
      return;
    }

    // Check if all required statuses are COMPLETED
    const quotesStatus = episode.quotes_audio_status;
    const chunkingStatus = episode.chunking_status;
    
    logger.info(`Episode ${episodeId} status check - quotes_audio_status: ${quotesStatus}, chunking_status: ${chunkingStatus}`);
    
    if (quotesStatus === 'COMPLETED' && chunkingStatus === 'COMPLETED') {
      // All statuses are complete, queue message to video trimming
      const messageBody = JSON.stringify({ id: episodeId });
      
      logger.info(`All processing completed for episode ${episodeId}, queuing to video trimming`);
      logger.info(`Using video trimming queue URL: ${trimQueueUrl}`);
      
      await sqsService!.sendMessage(messageBody, undefined, trimQueueUrl);
      
      logger.info(`Successfully queued episode ${episodeId} to video trimming queue`);
    } else {
      logger.info(`Episode ${episodeId} not ready for trimming - quotes_audio_status: ${quotesStatus}, chunking_status: ${chunkingStatus}`);
    }
  } catch (error: any) {
    logger.error(`Failed to check and queue video trimming for episode ${episodeId}: ${error.message}`);
  }
}

// Startup function with yt-dlp update check and periodic monitoring
async function startServer(): Promise<void> {
  console.log('🔧 Performing startup checks...');
  
  // Read configuration from environment variables
  const useNightly = process.env.YTDLP_USE_NIGHTLY === 'true';
  const enableSQS = process.env.ENABLE_SQS_POLLING !== 'false';
  
  const updateOptions: UpdateOptions = {
    useNightly
  };
  
  try {
    // Check for yt-dlp updates before starting the server
    console.log(`📦 Checking for yt-dlp updates (${useNightly ? 'nightly' : 'stable'})...`);
    const wasUpdated = await checkAndUpdateYtdlp(updateOptions);
    
    if (wasUpdated) {
      console.log(`✅ yt-dlp has been updated to the latest ${useNightly ? 'nightly' : 'stable'} version`);
    } else {
      console.log(`ℹ️ yt-dlp is already up to date (${useNightly ? 'nightly' : 'stable'}) or update was not needed`);
    }
    
    // Periodic update checks disabled for cloud deployment
    // Updates will be handled via container orchestration or manual API calls
    console.log('⏸️ Periodic update checks are disabled for cloud deployment');
    
    // Start the server
    const server = app.listen(PORT, async () => {
      console.log(`🎙️ Podcast Processing Pipeline running on port ${PORT}`);
      console.log(`📍 API Documentation: http://localhost:${PORT}/`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
      console.log(`📁 Downloads: http://localhost:${PORT}/downloads/`);
      console.log(`📦 Update Status: http://localhost:${PORT}/api/update-status`);
      console.log(`🔄 Manual Update: POST http://localhost:${PORT}/api/update-ytdlp`);
      console.log(`🌙 Using ${useNightly ? 'nightly' : 'stable'} yt-dlp builds`);
      console.log(`🎧 Podcast Conversion: ${isPodcastConversionEnabled ? 'Enabled' : 'Disabled'}`);
      
      // Start SQS polling if enabled
      if (enableSQS) {
        try {
          // Import SQS polling functionality
          const { startSQSPolling } = await import('./sqsPoller.js');
          
          // Start polling
          startSQSPolling();
          console.log('📬 SQS polling started with job queue limit of ' + 
            process.env.MAX_CONCURRENT_JOBS || '2');
        } catch (sqsError: any) {
          console.error('⚠️ SQS polling could not be started:', sqsError.message);
        }
      } else {
        console.log('📪 SQS polling is disabled');
      }
      
      console.log('✨ Server startup completed successfully');
    });
    
    // Setup graceful shutdown
    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down server...');
      server.close();
    });
    
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down server...');
      server.close();
    });
    
  } catch (error: any) {
    console.error('❌ Failed to start server:', error.message);
    console.error('💡 Server will start anyway, but yt-dlp might not be up to date');
    
    const server = app.listen(PORT, async () => {
      console.log(`🚀 YouTube Download Server running on port ${PORT} (with warnings)`);
      console.log(`📍 API Documentation: http://localhost:${PORT}/`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
      console.log(`📁 Downloads: http://localhost:${PORT}/downloads/`);
      console.log(`🌙 Using ${useNightly ? 'nightly' : 'stable'} yt-dlp builds`);
      
      // Start SQS polling if enabled
      if (enableSQS) {
        try {
          const { startSQSPolling } = await import('./sqsPoller.js');
          startSQSPolling();
          console.log('📬 SQS polling started');
        } catch (sqsError: any) {
          console.error('⚠️ SQS polling could not be started:', sqsError.message);
        }
      }
      
      console.log('⚠️ Server started with update check failure');
    });
  }
}

startServer();

export default app;

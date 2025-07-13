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
  SQSJobMessage,
} from './types.js';
import { SQSMessageBody } from './lib/rdsService.js';
import { 
  getVideoMetadata,
  downloadAndMergeVideo,
  downloadVideoWithAudioSimple
} from './lib/ytdlpWrapper.js';
import { isValidYouTubeUrl, sanitizeYouTubeUrl } from './lib/utils/urlUtils.js';
import { checkAndUpdateYtdlp, getUpdateStatus, UpdateOptions } from './lib/update_ytdlp.js';
import { createS3ServiceFromEnv} from './lib/s3Service.js';
import { createSQSServiceFromEnv} from './lib/sqsService.js';
import { RDSService, createRDSServiceFromEnv } from './lib/rdsService.js';
import { logger } from './lib/utils/logger.js';
import { create_slug} from './lib/utils/utils.js';
import { GuestExtractionService, GuestExtractionResult } from './lib/guestExtractionService.js';

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

// Initialize RDS service with SSL required
const rdsService = createRDSServiceFromEnv() || new RDSService({
  host: process.env.RDS_HOST || 'localhost',
  user: process.env.RDS_USER || 'postgres',
  password: process.env.RDS_PASSWORD || '',
  database: process.env.RDS_DATABASE || 'postgres',
  port: parseInt(process.env.RDS_PORT || '5432'),
  ssl: { rejectUnauthorized: false }, // Always require SSL for RDS connections
});

const isRDSEnabled = !!(process.env.RDS_HOST && process.env.RDS_USER && process.env.RDS_PASSWORD);

// Internal guest extraction tool, only used during new episode processing
const guestExtractionService = GuestExtractionService.createFromEnv(isRDSEnabled ? rdsService : undefined);

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

if (isRDSEnabled) {
  logger.info('RDS service initialized successfully');
} else {
  logger.warn('RDS service disabled or not configured');
}

// ...existing code...

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
    processDownload(jobId, sanitizedUrl, undefined);

    res.json({
      success: true,
      jobId,
      message: 'Download job started successfully'
    });
  } catch (error) {
    logger.error('Error starting download', error as Error);
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
export async function processDownload(jobId: string, url: string, sqsJobMessage?: SQSJobMessage): Promise<void> {
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
    let guestExtractionResult: GuestExtractionResult | undefined;
    try {
      metadata = await getVideoMetadata(url);
      
      job = downloadJobs.get(jobId); 
      if (!job) {
        console.warn(`Job ${jobId} was deleted during metadata fetch.`);
        return;
      }
      // Fetch manifest URL, download it and upload to S3

      job.metadata = metadata;
      await persistJobUpdate(jobId, job);      
      console.log(`Job ${jobId}: Metadata fetched successfully.`);

      if (guestExtractionService && metadata.title && metadata.description) {
        console.log(`Job ${jobId}: Starting guest and topic extraction...`);
        job.status = 'extracting_guests';
        await persistJobUpdate(jobId, job);
        try {
          guestExtractionResult = await guestExtractionService.extractPodcastWithBiosAndImages({
            podcast_title: metadata.uploader || 'Unknown Podcast',
            episode_title: metadata.title,
            episode_description: metadata.description
          });
          job = downloadJobs.get(jobId);
          if (job) {
            job.guestExtraction = guestExtractionResult;
            await persistJobUpdate(jobId, job);
            console.log(`Job ${jobId}: Guest extraction completed. Found ${guestExtractionResult.guest_names.length} guests and ${guestExtractionResult.topics.length} topics`);
            if (guestExtractionResult.guest_names.length > 0) {
              console.log(`Job ${jobId}: Guests found: ${guestExtractionResult.guest_names.join(', ')}`);
              console.log(`Job ${jobId}: Topics extracted: ${guestExtractionResult.topics.join(', ')}`);
            }
          }
        } catch (extractionError: any) {
          console.error(`Job ${jobId}: Guest extraction failed:`, extractionError);
          job = downloadJobs.get(jobId);
          if (job) {
            job.guestExtractionError = extractionError.message;
            await persistJobUpdate(jobId, job);
          }
        }
      }
      
    } catch (metaError: any) {
      console.error(`Job ${jobId}: Failed to fetch metadata:`, metaError);
      job = downloadJobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = `Failed to fetch metadata: ${metaError?.message || String(metaError)}`;
        job.completedAt = new Date();
        await persistJobUpdate(jobId, job);
        await cleanupMetadataFile(jobId);
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
      const channelId = sqsJobMessage?.channelId  || (metadata ? create_slug(metadata.uploader || 'unknown') : 'unknown');
      
      // Construct SQSMessageBody from either new format (top-level fields) or legacy channelInfo
      let channelInfo: SQSMessageBody | undefined;
      if (sqsJobMessage) {
        if (sqsJobMessage.videoId || sqsJobMessage.episodeTitle || sqsJobMessage.channelName) {
          channelInfo = {
            videoId: sqsJobMessage.videoId || metadata?.id || '',
            episodeTitle: sqsJobMessage.episodeTitle || metadata?.title || '',
            channelName: sqsJobMessage.channelName || metadata?.uploader || 'Unknown Channel',
            channelId: sqsJobMessage.channelId || channelId,
            originalUri: sqsJobMessage.originalUri || url,
            publishedDate: sqsJobMessage.publishedDate || new Date().toISOString(),
            contentType: 'Video', // Always Video for new structure
            hostName: sqsJobMessage.hostName || metadata?.uploader || '',
            hostDescription: sqsJobMessage.hostDescription || '',
            genre: sqsJobMessage.genre || '',
            country: sqsJobMessage.country || '',
            websiteLink: sqsJobMessage.websiteLink || '',
            additionalData: {
              youtubeVideoId: sqsJobMessage.videoId || metadata?.id || '',
              youtubeChannelId: sqsJobMessage.channelId || channelId,
              youtubeUrl: sqsJobMessage.originalUri || url,
              notificationReceived: new Date().toISOString(),
              ...(sqsJobMessage.additionalData || {})
            }
          };
        } 
        
      }
      
      const {mergedFilePath, episodeId} = await downloadAndMergeVideo(channelId, url,
        {
        outputDir: downloadsDir,
        outputFilename: outputFilename,
        s3Upload: { 
          enabled: isS3Enabled,
          deleteLocalAfterUpload: true
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
      }, metadata, channelInfo, guestExtractionResult);

      // Update job with final merged file path
      const finalJobState = downloadJobs.get(jobId);
      if (finalJobState) {
        if (!finalJobState.filePaths) finalJobState.filePaths = {};
        
        // Handle the new return type from downloadAndMergeVideo
        const mergedResult = mergedFilePath as any;
        const finalMergedPath = mergedResult.mergedPath || mergedResult;
        const audioOnlyPath = mergedResult.audioPath;
        
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
        
        // Clean up metadata file after successful completion
        await cleanupMetadataFile(jobId);
      
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
      
      // Clean up metadata file even on error
      await cleanupMetadataFile(jobId);
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
    
    // Clean up metadata file on critical failure
    await cleanupMetadataFile(jobId);
  }
}

/**
 * Download video for an existing podcast episode without creating new audio or metadata
 * Updates the videoFileName in RDS and checks for trimming queue eligibility
 */
export async function downloadVideoForExistingEpisode(episodeId: string, videoUrl: string): Promise<void> {
  if (!isRDSEnabled) {
    throw new Error('RDS is not enabled - cannot process existing episode');
  }

  try {
    // 1. Get existing episode data from RDS
    logger.info(`Fetching existing episode data for ${episodeId}`);
    const existingEpisode = await rdsService.getEpisode(episodeId);
    
    if (!existingEpisode) {
      throw new Error(`Episode ${episodeId} not found in database`);
    }

    logger.info(`Found existing episode: ${existingEpisode.episodeTitle || 'Unknown Title'}`);

    // 2. Get video metadata (for filename generation)
    logger.info(`Fetching video metadata for ${videoUrl}`);
    const metadata = await getVideoMetadata(videoUrl);

    // 3. Download video with audio (simple download, no database operations)
    logger.info(`Starting video+audio download for existing episode ${episodeId}`);
    
    // Generate output filename using existing episode data
    const podcastSlug = create_slug(existingEpisode.channelName || metadata.uploader || 'unknown');
    const episodeSlug = create_slug(existingEpisode.episodeTitle || metadata.title || 'untitled');
    const outputFilename = `${podcastSlug}/${episodeSlug}.mp4`;

    const videoPath = await downloadVideoWithAudioSimple(videoUrl, {
      outputDir: downloadsDir,
      outputFilename: outputFilename,
      s3Upload: { 
        enabled: isS3Enabled,
        deleteLocalAfterUpload: true 
      },
      onProgress: (progressInfo: ProgressInfo) => {
        logger.debug(`Video+audio download progress for ${episodeId}:`, progressInfo);
      }
    }, metadata);

    logger.info(`Video+audio download completed: ${videoPath}`);

    // 4. Update RDS entry with video file name
    let episodeUri: string;
    if (isS3Enabled && !path.isAbsolute(videoPath)) {
      episodeUri = `https://${process.env.S3_BUCKET_NAME}.s3.us-east-1.amazonaws.com/${videoPath}`;
      logger.info(`Using S3 URL for RDS: ${episodeUri}`);
    } else {
      // Local path returned, convert to relative path
      episodeUri = path.relative(downloadsDir, videoPath);
      logger.info(`Using relative local path for RDS: ${episodeUri}`);
    }
    
    await rdsService.updateEpisode(episodeId, {
      episodeUri: episodeUri,
    });

    logger.info(`Updated episode ${episodeId} with episodeUri: ${episodeUri}`);
  } catch (error: any) {
    logger.error(`Failed to download video for existing episode ${episodeId}: ${error.message}`, error);
    
    // Update episode with error status if possible
    try {
      if (isRDSEnabled) {
        const currentEpisode = await rdsService.getEpisode(episodeId);
        await rdsService.updateEpisode(episodeId, {
          additionalData: { 
            ...currentEpisode?.additionalData, 
            videoDownloadError: error.message 
          }
        });
      }
    } catch (updateError: any) {
      logger.error(`Failed to update episode ${episodeId} with error status: ${updateError.message}`);
    }
    
    throw error;
  }
}
/**
 * POST /api/download-video-existing
 * Download video for an existing podcast episode
 */
app.post('/api/download-video-existing', async (req: Request, res: Response) => {
  try {
    const { episodeId, videoUrl } = req.body;

    if (!episodeId || !videoUrl) {
      res.status(400).json({
        success: false,
        message: 'Both episodeId and videoUrl are required'
      });
      return;
    }

    if (!isValidYouTubeUrl(videoUrl)) {
      res.status(400).json({
        success: false,
        message: 'Invalid YouTube URL provided'
      });
      return;
    }

    if (!isRDSEnabled) {
      res.status(500).json({
        success: false,
        message: 'RDS is not enabled - cannot process existing episodes'
      });
      return;
    }

    const sanitizedUrl = sanitizeYouTubeUrl(videoUrl);

    // Start the download process asynchronously
    downloadVideoForExistingEpisode(episodeId, sanitizedUrl)
      .then(() => {
        logger.info(`Video download completed for existing episode ${episodeId}`);
      })
      .catch((error: any) => {
        logger.error(`Video download failed for existing episode ${episodeId}: ${error.message}`);
      });

    res.json({
      success: true,
      message: `Video download started for episode ${episodeId}`,
      episodeId,
      videoUrl: sanitizedUrl
    });
  } catch (error) {
    logger.error('Error starting video download for existing episode', error as Error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'podcast-pipeline',
    timestamp: new Date().toISOString(),
    s3Enabled: isS3Enabled,
    sqsEnabled: isSQSEnabled,
    rdsEnabled: isRDSEnabled,
    // guestExtractionEnabled: false,
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
      'POST /api/download-video-existing': 'Download video for existing podcast episode',
      'GET /api/job/:jobId': 'Get podcast processing job status',
      'GET /api/jobs': 'Get all podcast processing jobs',
      'DELETE /api/job/:jobId': 'Delete a podcast processing job',
      'GET /health': 'Health check',
      'GET /downloads/*': 'Access downloaded podcast files'
    },
    usage: {
      'Start Podcast Processing': 'POST /api/download with { "url": "https://youtube.com/watch?v=..." }',
      'Download Video for Existing Episode': 'POST /api/download-video-existing with { "episodeId": "uuid", "videoUrl": "https://youtube.com/watch?v=..." }',
      'Check Status': 'GET /api/job/{jobId}',
      'List All Jobs': 'GET /api/jobs',
      'Update yt-dlp': 'POST /api/update-ytdlp with { "nightly": true/false, "force": true/false }',
      'Update Status': 'GET /api/update-status',
      'SQS Message Format (New)': '{ "jobId": "uuid" (optional), "url": "https://youtube.com/...", "channelId": "channel-id" (optional) }',
      'SQS Message Format (Existing)': '{ "id": "episodeId", "url": "https://youtube.com/..." }'
    },
    features: {
      'Podcast Conversion': isPodcastConversionEnabled ? 'Enabled' : 'Disabled',
      'Audio Extraction': 'Always Enabled',
      'S3 Upload': isS3Enabled ? 'Enabled' : 'Disabled',
      'SQS Queue': isSQSEnabled ? 'Enabled' : 'Disabled',
      'RDS Storage': isRDSEnabled ? 'Enabled (PostgreSQL)' : 'Disabled',
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
      
      // Clean up any orphaned metadata files from previous runs
      await cleanupOrphanedMetadataFiles();
      console.log('🧹 Orphaned metadata file cleanup completed');
      // Initialize RDS connection if enabled
      await rdsService.initClient()
        .then(() => console.log('🗄️ RDS connection initialized successfully'))
        .catch(err => console.error('❌ Failed to initialize RDS connection:', err.message));
      console.log('✨ Server startup completed successfully');
    });
    
    // Setup graceful shutdown
    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down server...');
      await rdsService.closeClient(); // Close RDS connection
      server.close();
    });
    
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down server...');
      await rdsService.closeClient(); // Close RDS connection
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


/**
 * Clean up metadata file for a job
 */
async function cleanupMetadataFile(jobId: string): Promise<void> {
  try {
    const job = downloadJobs.get(jobId);
    if (job?.filePaths?.metadataPath) {
      const metadataFilePath = path.join(downloadsDir, job.filePaths.metadataPath);
      
      try {
        await fs.promises.access(metadataFilePath);
        await fs.promises.unlink(metadataFilePath);
        console.log(`Job ${jobId}: Metadata file cleaned up: ${metadataFilePath}`);
      } catch (accessError: any) {
        if (accessError.code !== 'ENOENT') {
          console.warn(`Job ${jobId}: Failed to delete metadata file ${metadataFilePath}:`, accessError);
        }
        // If file doesn't exist (ENOENT), no need to log as it's already cleaned up
      }
    }
  } catch (error: any) {
    console.error(`Job ${jobId}: Error during metadata cleanup:`, error);
  }
}

/**
 * Clean up orphaned metadata files from previous runs
 */
async function cleanupOrphanedMetadataFiles(): Promise<void> {
  try {
    const files = await fs.promises.readdir(downloadsDir);
    const metadataFiles = files.filter(file => file.endsWith('_metadata.json'));
    
    if (metadataFiles.length > 0) {
      console.log(`Found ${metadataFiles.length} orphaned metadata files, cleaning up...`);
      
      for (const file of metadataFiles) {
        try {
          const filePath = path.join(downloadsDir, file);
          await fs.promises.unlink(filePath);
          console.log(`Cleaned up orphaned metadata file: ${file}`);
        } catch (error: any) {
          console.warn(`Failed to delete orphaned metadata file ${file}:`, error);
        }
      }
    }
  } catch (error: any) {
    console.error('Error during orphaned metadata cleanup:', error);
  }
}
startServer();

export default app;

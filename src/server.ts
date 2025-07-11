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
  downloadVideoNoAudioWithProgress,
  downloadVideoWithAudioSimple
} from './lib/ytdlpWrapper.js';
import { isValidYouTubeUrl, sanitizeYouTubeUrl } from './lib/urlUtils.js';
import { checkAndUpdateYtdlp, getUpdateStatus, UpdateOptions } from './lib/update_ytdlp.js';
import { createS3ServiceFromEnv} from './lib/s3Service.js';
import { createSQSServiceFromEnv} from './lib/sqsService.js';
import { RDSService, createRDSServiceFromEnv } from './lib/rdsService.js';
import { logger } from './lib/logger.js';
import { create_slug } from './lib/utils/utils.js';
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

// Initialize Guest Extraction service
const guestExtractionService = GuestExtractionService.createFromEnv(isRDSEnabled ? rdsService : undefined);
const isGuestExtractionEnabled = guestExtractionService !== null;

// Pass guest extraction service to RDS service if both are available
if (isRDSEnabled && isGuestExtractionEnabled) {
  rdsService['guestExtractionService'] = guestExtractionService;
  logger.info('Guest extraction service linked to RDS service');
}

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

if (isGuestExtractionEnabled) {
  logger.info('Guest extraction service initialized successfully');
} else {
  logger.warn('Guest extraction service disabled - requires Gemini API key');
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
 * POST /api/extract-guests
 * Extract guest information from episode metadata
 */
app.post('/api/extract-guests', async (req: Request, res: Response) => {
  try {
    const { episodeId, metadata } = req.body;

    if (!episodeId || !metadata) {
      res.status(400).json({
        success: false,
        message: 'Both episodeId and metadata (title, description, uploader) are required'
      });
      return;
    }

    if (!isGuestExtractionEnabled) {
      res.status(503).json({
        success: false,
        message: 'Guest extraction service is not enabled'
      });
      return;
    }

    if (!isRDSEnabled) {
      res.status(503).json({
        success: false,
        message: 'RDS is not enabled - cannot update episode'
      });
      return;
    }

    // Extract guests and topics
    const extractionResult = await guestExtractionService!.extractAndUpdateEpisode(episodeId, {
      podcast_title: metadata.uploader || 'Unknown Podcast',
      episode_title: metadata.title || 'Unknown Episode',
      episode_description: metadata.description || ''
    });

    if (extractionResult) {
      res.json({
        success: true,
        message: 'Guest extraction completed successfully',
        data: {
          episodeId,
          guestCount: extractionResult.guest_names.length,
          topicCount: extractionResult.topics.length,
          guests: extractionResult.guest_names,
          topics: extractionResult.topics,
          description: extractionResult.description
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Guest extraction failed'
      });
    }

  } catch (error: any) {
    console.error('Guest extraction error:', error);
    res.status(500).json({
      success: false,
      message: `Guest extraction failed: ${error.message}`
    });
  }
});

/**
 * POST /api/extract-guests-metadata
 * Extract guest information from video metadata only (no database update)
 */
app.post('/api/extract-guests-metadata', async (req: Request, res: Response) => {
  try {
    const { metadata } = req.body;

    if (!metadata || !metadata.title || !metadata.description) {
      res.status(400).json({
        success: false,
        message: 'Metadata with title and description is required'
      });
      return;
    }

    if (!isGuestExtractionEnabled) {
      res.status(503).json({
        success: false,
        message: 'Guest extraction service is not enabled'
      });
      return;
    }

    // Extract guests and topics without updating database
    const extractionResult = await guestExtractionService!.extractPodcastWithBiosAndImages({
      podcast_title: metadata.uploader || 'Unknown Podcast',
      episode_title: metadata.title,
      episode_description: metadata.description
    });

    res.json({
      success: true,
      message: 'Guest extraction completed successfully',
      data: {
        guestCount: extractionResult.guest_names.length,
        topicCount: extractionResult.topics.length,
        guests: extractionResult.guest_names,
        topics: extractionResult.topics,
        description: extractionResult.description,
        guestDetails: extractionResult.guest_details
      }
    });

  } catch (error: any) {
    console.error('Guest extraction error:', error);
    res.status(500).json({
      success: false,
      message: `Guest extraction failed: ${error.message}`
    });
  }
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
    logger.error('Error searching YouTube', error as Error);
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
    
    logger.debug('Fetching YouTube search results', { searchUrl: searchUrl.toString() });

    const response = await fetch(searchUrl.toString());
    logger.debug('YouTube API response received', { status: response.status });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error('YouTube API error response', undefined, { errorText });
      throw new Error(`YouTube API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const searchData = await response.json() as any;
    
    if (!searchData.items || searchData.items.length === 0) {
      logger.info('No search results found');
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
      logger.error('YouTube videos API error', undefined, { errorText });
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
        
        logger.debug('Added video to search results', { 
          title, 
          duration: `${Math.floor(durationInSeconds / 60)}:${(durationInSeconds % 60).toString().padStart(2, '0')}` 
        });
      } else {
        logger.debug('Skipped video (too short)', { 
          title: video.snippet.title, 
          duration: `${Math.floor(durationInSeconds / 60)}:${(durationInSeconds % 60).toString().padStart(2, '0')}` 
        });
      }
    }

    logger.info('YouTube search completed', { resultsCount: Object.keys(results).length });
    return results;

  } catch (error) {
    logger.error('Error in searchYouTubeVideos', error as Error);
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
      job.metadata = metadata;
      await persistJobUpdate(jobId, job);      
      console.log(`Job ${jobId}: Metadata fetched successfully.`);

      // 2. Extract guests and topics if service is available
      if (isGuestExtractionEnabled && metadata.title && metadata.description) {
        console.log(`Job ${jobId}: Starting guest and topic extraction...`);
        job.status = 'extracting_guests';
        await persistJobUpdate(jobId, job);
        
        try {
          guestExtractionResult = await guestExtractionService!.extractPodcastWithBiosAndImages({
            podcast_title: metadata.uploader || 'Unknown Podcast',
            episode_title: metadata.title,
            episode_description: metadata.description
          });
          
          job = downloadJobs.get(jobId);
          if (job) {
            job.guestExtraction = guestExtractionResult;
            await persistJobUpdate(jobId, job);
            console.log(`Job ${jobId}: Guest extraction completed. Found ${guestExtractionResult.guest_names.length} guests and ${guestExtractionResult.topics.length} topics`);
            
            // Log guest details if any were found
            if (guestExtractionResult.guest_names.length > 0) {
              console.log(`Job ${jobId}: Guests found: ${guestExtractionResult.guest_names.join(', ')}`);
              console.log(`Job ${jobId}: Topics extracted: ${guestExtractionResult.topics.join(', ')}`);
            }
          }
        } catch (extractionError: any) {
          console.error(`Job ${jobId}: Guest extraction failed:`, extractionError);
          // Continue with download even if guest extraction fails
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
        // Clean up metadata file if it was created before the error
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
      // Extract channel info from SQS message or generate fallback channelId
      const channelId = sqsJobMessage?.channelId || sqsJobMessage?.channelInfo?.channelId || (metadata ? create_slug(metadata.uploader || 'unknown') : 'unknown');
      
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
        else if (sqsJobMessage.channelInfo) {
          channelInfo = {
            videoId: metadata?.id || '',
            episodeTitle: metadata?.title || '',
            channelName: sqsJobMessage.channelInfo.channelName,
            channelId: sqsJobMessage.channelInfo.channelId,
            originalUri: url,
            publishedDate: new Date().toISOString(),
            contentType: 'Video',
            hostName: sqsJobMessage.channelInfo.hostName || metadata?.uploader || '',
            hostDescription: sqsJobMessage.channelInfo.hostDescription || '',
            genre: sqsJobMessage.channelInfo.genre || '',
            country: sqsJobMessage.channelInfo.country || '',
            websiteLink: '',
            additionalData: {
              youtubeVideoId: metadata?.id || '',
              youtubeChannelId: sqsJobMessage.channelInfo.channelId,
              youtubeUrl: url,
              notificationReceived: new Date().toISOString(),
              channelDescription: sqsJobMessage.channelInfo.channelDescription,
              channelThumbnail: sqsJobMessage.channelInfo.channelThumbnail,
              subscriberCount: sqsJobMessage.channelInfo.subscriberCount,
              verified: sqsJobMessage.channelInfo.verified,
              rssUrl: sqsJobMessage.channelInfo.rssUrl
            }
          };
        }
      }
      
      const {mergedFilePath, episodePK, episodeSK} = await downloadAndMergeVideo(channelId, url, {
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
        
        // Check if metadata processing is complete and queue for video trimming if ready
        if (episodePK) {
          // Extract episodeId from PK format (EPISODE#episodeId)
          const episodeId = episodePK.replace('EPISODE#', '');
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
    guestExtractionEnabled: isGuestExtractionEnabled,
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
      'POST /api/extract-guests': 'Extract guests and topics from podcast data',
      'POST /api/extract-guests-from-metadata': 'Extract guests and topics from YouTube video metadata',
      'GET /api/job/:jobId': 'Get podcast processing job status',
      'GET /api/jobs': 'Get all podcast processing jobs',
      'DELETE /api/job/:jobId': 'Delete a podcast processing job',
      'GET /api/search/:query': 'Search YouTube videos for podcast content',
      'GET /health': 'Health check',
      'GET /downloads/*': 'Access downloaded podcast files'
    },
    usage: {
      'Start Podcast Processing': 'POST /api/download with { "url": "https://youtube.com/watch?v=..." }',
      'Download Video for Existing Episode': 'POST /api/download-video-existing with { "episodeId": "uuid", "videoUrl": "https://youtube.com/watch?v=..." }',
      'Extract Guests': 'POST /api/extract-guests with { "podcast_title": "...", "episode_title": "...", "episode_description": "..." }',
      'Extract from Video': 'POST /api/extract-guests-from-metadata with { "url": "https://youtube.com/watch?v=..." }',
      'Check Status': 'GET /api/job/{jobId}',
      'List All Jobs': 'GET /api/jobs',
      'Search Podcast Content': 'GET /api/search/{query}?maxResults=10',
      'Update yt-dlp': 'POST /api/update-ytdlp with { "nightly": true/false, "force": true/false }',
      'Update Status': 'GET /api/update-status',
      'SQS Message Format (New)': '{ "jobId": "uuid" (optional), "url": "https://youtube.com/...", "channelId": "channel-id" (optional) }',
      'SQS Message Format (Existing)': '{ "id": "episodeId", "url": "https://youtube.com/..." }'
    },
    features: {
      'Podcast Conversion': isPodcastConversionEnabled ? 'Enabled' : 'Disabled',
      'Audio Extraction': 'Always Enabled',
      'Guest Extraction': isGuestExtractionEnabled ? 'Enabled (Gemini + Perplexity + Google Images)' : 'Disabled (Missing API Keys)',
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

/**
 * Check if episode metadata indicates all processing is complete
 * and queue message to video trimming SQS queue if ready
 * @param episodeId - Episode ID to check and potentially queue
 */
async function checkAndQueueVideoTrimming(episodeId: string): Promise<void> {
  if (!isRDSEnabled || !isSQSEnabled) {
    logger.warn('RDS or SQS not enabled, skipping video trimming queue check');
    return;
  }

  const trimQueueUrl = process.env.VIDEO_TRIMMING_QUEUE_URL;

  try {
    // Get episode data from RDS using episode ID
    const episode = await rdsService.getEpisode(episodeId);
    
    if (!episode) {
      logger.warn(`Episode ${episodeId} not found in database, cannot check trimming status`);
      return;
    }

    // Check if all processing is done
    const processingInfo = episode.processingInfo;
    
    logger.info(`Episode ${episodeId} status check - processingDone: ${episode.processingDone}`);
    
    if (episode.processingDone && processingInfo.chunkingDone) {
      // All statuses are complete, queue message to video trimming
      const messageBody = JSON.stringify({ id: episodeId });
      
      logger.info(`All processing completed for episode ${episodeId}, queuing to video trimming`);
      logger.info(`Using video trimming queue URL: ${trimQueueUrl}`);
      
      await sqsService!.sendMessage(messageBody, undefined, trimQueueUrl);
      
      logger.info(`Successfully queued episode ${episodeId} to video trimming queue`);
    } else {
      logger.info(`Episode ${episodeId} not ready for trimming - processingDone: ${episode.processingDone}, chunkingDone: ${processingInfo.chunkingDone}`);
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
      console.log(`🧠 Guest Extraction: POST http://localhost:${PORT}/api/extract-guests`);
      console.log(`🌙 Using ${useNightly ? 'nightly' : 'stable'} yt-dlp builds`);
      console.log(`🎧 Podcast Conversion: ${isPodcastConversionEnabled ? 'Enabled' : 'Disabled'}`);
      console.log(`👥 Guest Extraction: ${isGuestExtractionEnabled ? 'Enabled' : 'Disabled'}`);
      if (isGuestExtractionEnabled) {
        console.log(`   └── Gemini API: ${process.env.GEMINI_API_KEY ? 'Configured' : 'Missing'}`);
        console.log(`   └── Perplexity API: ${process.env.PERPLEXITY_API_KEY ? 'Configured' : 'Missing'}`);
        console.log(`   └── Google Search API: ${process.env.SEARCH_API_KEY ? 'Configured' : 'Missing'}`);
      }
      
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
        deleteLocalAfterUpload: true // Clean up local files after S3 upload
      },
      onProgress: (progressInfo: ProgressInfo) => {
        logger.debug(`Video+audio download progress for ${episodeId}:`, progressInfo);
      }
    }, metadata);

    logger.info(`Video+audio download completed: ${videoPath}`);

    // 4. Update RDS entry with video file name
    // If S3 upload was successful, videoPath will be the S3 key
    // If S3 upload was disabled or failed, videoPath will be the local path
    let episodeUrl: string;
    if (isS3Enabled && !path.isAbsolute(videoPath)) {
      // S3 key returned (relative path format), convert to full S3 URL
      episodeUrl = `https://${process.env.S3_BUCKET_NAME}.s3. us-east-1.amazonaws.com/${videoPath}`;
      logger.info(`Using S3 URL for RDS: ${episodeUrl}`);
    } else {
      // Local path returned, convert to relative path
      episodeUrl = path.relative(downloadsDir, videoPath);
      logger.info(`Using relative local path for RDS: ${episodeUrl}`);
    }
    
    await rdsService.updateEpisode(episodeId, {
      episodeUri: episodeUrl,
    });

    logger.info(`Updated episode ${episodeId} with episodeUrl: ${episodeUrl}`);

    // 5. Check if episode is ready for video trimming
    const updatedEpisode = await rdsService.getEpisode(episodeId);
    if (updatedEpisode) {
      const processingDone = updatedEpisode.processingDone;
      const chunkingDone = updatedEpisode.processingInfo.chunkingDone;
      
      logger.info(`Episode ${episodeId} status check - processingDone: ${processingDone}, chunkingDone: ${chunkingDone}`);
      
      if (processingDone && chunkingDone) {
        await queueVideoTrimming(episodeId);
      } else {
        logger.info(`Episode ${episodeId} not ready for trimming - waiting for other processing to complete`);
      }
    }

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
 * Helper function to queue episode for video trimming
 */
async function queueVideoTrimming(episodeId: string): Promise<void> {
  if (!isSQSEnabled) {
    logger.warn('SQS not enabled, cannot queue for video trimming');
    return;
  }

  const trimQueueUrl = process.env.VIDEO_TRIMMING_QUEUE_URL;
  if (!trimQueueUrl) {
    logger.warn('VIDEO_TRIMMING_QUEUE_URL not configured, cannot queue for video trimming');
    return;
  }

  try {
    const messageBody = JSON.stringify({ id: episodeId });
    
    logger.info(`Queuing episode ${episodeId} to video trimming queue`);
    await sqsService!.sendMessage(messageBody, undefined, trimQueueUrl);
    
    logger.info(`Successfully queued episode ${episodeId} to video trimming queue`);
  } catch (error: any) {
    logger.error(`Failed to queue episode ${episodeId} for video trimming: ${error.message}`);
    throw error;
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
      
      // Check if file exists before attempting to delete
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

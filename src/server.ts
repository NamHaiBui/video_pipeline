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
import { logger } from './lib/logger.js';
import { DynamoDBService } from './lib/dynamoService.js';
import { generateVideoS3Key, generateAudioS3Key, generateMetadataS3Key, getVideoBucketName, getAudioBucketName, getMetadataBucketName } from './lib/s3KeyUtils.js';

import dotenv from 'dotenv';

// Load environment-specific configuration
if (process.env.LOCALSTACK === 'true') {
  console.log('🧪 Loading LocalStack environment configuration...');
  dotenv.config({ path: '.env.localstack' });
} else {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Initialize S3 service
const s3Service = createS3ServiceFromEnv();
const isS3Enabled = s3Service !== null && process.env.S3_UPLOAD_ENABLED !== 'false';

// Initialize DynamoDB service
const dynamoService = new DynamoDBService({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  endpointUrl: process.env.LOCALSTACK === 'true' ? 'http://localhost:4566' : undefined,
  metadataTableName: process.env.DYNAMODB_METADATA_TABLE || 'video-pipeline-metadata',
  jobsTableName: process.env.DYNAMODB_JOBS_TABLE || 'video-pipeline-jobs',
  podcastEpisodesTableName: process.env.DYNAMODB_PODCAST_EPISODES_TABLE || 'PodcastEpisodeStore'
});

const isDynamoEnabled = process.env.LOCALSTACK === 'true' || 
  (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

const isPodcastConversionEnabled = process.env.PODCAST_CONVERSION_ENABLED !== 'false';

if (isS3Enabled) {
  logger.info('S3 upload service initialized successfully');
} else {
  logger.warn('S3 upload service disabled or not configured');
}

if (isDynamoEnabled) {
  logger.info('DynamoDB service initialized successfully');
} else {
  logger.warn('DynamoDB service disabled or not configured');
}

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for download jobs (in production, use a database)
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

    // Persist job to DynamoDB if enabled
    if (isDynamoEnabled) {
      try {
        await dynamoService.saveDownloadJob(job);
        logger.info('Job persisted to DynamoDB', { jobId: job.id });
      } catch (dynamoError: any) {
        logger.warn('Failed to persist job to DynamoDB', { 
          jobId, 
          error: dynamoError.message 
        });
      }
    }

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

    const searchData = await response.json();
    
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

    const detailsData = await detailsResponse.json();

    
    const results: Record<string, string> = {};
    let count = 0;

    for (const video of detailsData.items) {
      if (count >= maxResults) break;

      const duration = video.contentDetails.duration;
      const durationInSeconds = parseDuration(duration);
      
      // Filter: duration > 240 seconds (4 minutes)
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
 * Clean up temporary files
 */
async function cleanupTempFiles(files: string[]): Promise<void> {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        await fs.promises.unlink(file);
        console.log(`Cleaned up temp file: ${file}`);
      }
    } catch (error) {
      console.warn(`Failed to cleanup temp file ${file}:`, error);
    }
  }
}

/**
 * Helper function to persist job updates to both in-memory storage and DynamoDB
 */
async function persistJobUpdate(jobId: string, job: DownloadJob): Promise<void> {
  // Update in-memory storage
  downloadJobs.set(jobId, { ...job });
  
  // Persist to DynamoDB if enabled
  if (isDynamoEnabled) {
    try {
      await dynamoService.saveDownloadJob(job);
    } catch (dynamoError: any) {
      logger.warn('Failed to persist job update to DynamoDB', { 
        jobId, 
        error: dynamoError.message 
      });
    }
  }
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
    
    // Persist job to DynamoDB if enabled
    if (isDynamoEnabled) {
      try {
        await dynamoService.saveDownloadJob(job);
        logger.info('Job persisted to DynamoDB', { jobId: job.id });
      } catch (dynamoError: any) {
        logger.warn('Failed to persist job to DynamoDB', { 
          jobId, 
          error: dynamoError.message 
        });
      }
    }
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

    // Generate output filename using metadata
    let outputFilename = '%(title)s [%(id)s].mp4';
    if (metadata) {
      // Create a safe filename from metadata
      const safeTitle = metadata.title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      outputFilename = `${safeTitle} [${metadata.id}].mp4`;
    }

    try {
      // Use the new merged download function
      const mergedFilePath = await downloadAndMergeVideo(url, {
        outputDir: downloadsDir,
        outputFilename: outputFilename,
        onProgress: (progressInfo: ProgressInfo) => {
          const currentJobState = downloadJobs.get(jobId);
          if (currentJobState) {
            if (!currentJobState.progress) currentJobState.progress = {};
            
            // Determine which stage of the process we're in based on the progress message
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
        
        // Upload to S3 if enabled
        if (isS3Enabled && s3Service) {
              try {
                logger.info(`Starting S3 uploads for job ${jobId}`, { jobId });
                finalJobState.status = 'uploading';
                await persistJobUpdate(jobId, finalJobState);

                const metadataPath = finalJobState.filePaths.metadataPath ? 
                  path.join(downloadsDir, finalJobState.filePaths.metadataPath) : null;

                // Create custom S3 key using centralized key generation
                if (!finalJobState.metadata) {
                  throw new Error('Video metadata is required for S3 upload');
                }
                
                const videoExtension = path.extname(finalMergedPath);
                const videoKey = generateVideoS3Key(finalJobState.metadata, videoExtension);
                const videoBucketName = getVideoBucketName();

                // Upload video file to video bucket
                logger.info(`Uploading video file to S3: ${videoBucketName}/${videoKey}`, { jobId });
                const videoUpload = await s3Service.uploadFile(finalMergedPath, videoBucketName, videoKey);
                if (videoUpload.success) {
                  finalJobState.s3Locations = finalJobState.s3Locations || {};
                  finalJobState.s3Locations.video = {
                    bucket: videoUpload.bucket,
                    key: videoUpload.key,
                    location: videoUpload.location
                  };
                  logger.info(`Video uploaded successfully to S3: ${videoUpload.location}`, { jobId });
                } else {
                  logger.error(`Failed to upload video to S3 for Job ID ${jobId}: ${videoUpload.error}`);
                }

                // Use the downloaded audio file - no extraction needed
                try {
                  // Check if audio was already uploaded during download
                  if (audioS3Info) {
                    logger.info(`Audio was already uploaded during download: ${audioS3Info.location}`, { jobId });
                    
                    // Use the pre-uploaded audio file information
                    const audioUpload = {
                      success: true,
                      bucket: audioS3Info.bucket,
                      key: audioS3Info.key,
                      location: audioS3Info.location
                    };
                    
                    finalJobState.s3Locations = finalJobState.s3Locations || {};
                    finalJobState.s3Locations.audio = {
                      bucket: audioUpload.bucket,
                      key: audioUpload.key,
                      location: audioUpload.location
                    };
                    logger.info(`Using previously uploaded audio: ${audioUpload.location}`, { jobId });
                    
                    // Clean up the original audio file if it still exists
                    if (audioOnlyPath && fs.existsSync(audioOnlyPath)) {
                      try {
                        await fs.promises.unlink(audioOnlyPath);
                        logger.info(`Cleaned up original audio file: ${audioOnlyPath}`, { jobId });
                      } catch (deleteError) {
                        logger.warn(`Failed to clean up original audio file: ${audioOnlyPath}`, { jobId });
                      }
                    }
                  } else {
                    // Audio wasn't uploaded yet, do it now
                    const originalAudioPath = audioOnlyPath;
                    
                    if (!originalAudioPath || !fs.existsSync(originalAudioPath)) {
                      logger.warn(`Original audio file not found or doesn't exist: ${originalAudioPath}`, { jobId });
                      throw new Error(`Audio file not found at expected location: ${originalAudioPath}`);
                    }
                    
                    // Upload the original audio file directly to S3
                    const audioKey = generateAudioS3Key(finalJobState.metadata);
                    const audioBucketName = getAudioBucketName();
                    logger.info(`Uploading original audio file to S3: ${audioBucketName}/${audioKey} from ${originalAudioPath}`, { jobId });
                    const audioUpload = await s3Service.uploadFile(originalAudioPath, audioBucketName, audioKey);
                    
                    if (audioUpload.success) {
                      finalJobState.s3Locations = finalJobState.s3Locations || {};
                      finalJobState.s3Locations.audio = {
                        bucket: audioUpload.bucket,
                        key: audioUpload.key,
                        location: audioUpload.location
                      };
                      logger.info(`Audio uploaded successfully to S3: ${audioUpload.location}`, { jobId });
                      
                      // Store audio file path in job
                      if (!finalJobState.filePaths) finalJobState.filePaths = {};
                      finalJobState.filePaths.audioPath = path.basename(originalAudioPath);
                      
                      // Clean up original audio file after successful upload
                      try {
                        await fs.promises.unlink(originalAudioPath);
                        logger.info(`Cleaned up original audio file after S3 upload: ${originalAudioPath}`, { jobId });
                      } catch (deleteError) {
                        logger.warn(`Failed to clean up original audio file: ${originalAudioPath}`, { jobId });
                      }
                    } else {
                      logger.error(`Failed to upload audio to S3: ${audioUpload.error}`, undefined, { 
                        jobId,
                        error: audioUpload.error 
                      });
                    }
                  }
                } catch (audioError: any) {
                  logger.warn(`Failed to extract and upload audio: ${audioError.message}`, { jobId });
                }

                // Upload metadata file if it exists
                if (metadataPath && fs.existsSync(metadataPath)) {
                  const metadataKey = generateMetadataS3Key(finalJobState.metadata);
                  const metadataBucketName = getMetadataBucketName();
                  logger.info(`Uploading metadata file to S3: ${metadataBucketName}/${metadataKey}`, { jobId });
                  const metadataUpload = await s3Service.uploadFile(metadataPath, metadataBucketName, metadataKey, 'application/json');
                  if (metadataUpload.success) {
                    finalJobState.s3Locations = finalJobState.s3Locations || {};
                    finalJobState.s3Locations.metadata = {
                      bucket: metadataUpload.bucket,
                      key: metadataUpload.key,
                      location: metadataUpload.location
                    };
                    logger.info(`Metadata uploaded successfully to S3: ${metadataUpload.location}`, { jobId });
                  } else {
                    logger.error(`Failed to upload metadata to S3: ${metadataUpload.error}`, undefined, { jobId });
                  }
                }

                // Delete local files immediately after successful S3 upload (ephemeral storage)
                const filesToDelete = [finalMergedPath];
                if (metadataPath) filesToDelete.push(metadataPath);
                if (audioOnlyPath && fs.existsSync(audioOnlyPath)) filesToDelete.push(audioOnlyPath);
                
                console.log(`Job ${jobId}: Cleaning up ${filesToDelete.length} local files to maintain ephemeral storage...`);
                
                for (const filePath of filesToDelete) {
                  try {
                    if (fs.existsSync(filePath)) {
                      await fs.promises.unlink(filePath);
                      logger.info(`Deleted local file after S3 upload: ${filePath}`, { jobId });
                      console.log(`Job ${jobId}: ✅ Deleted local file: ${path.basename(filePath)}`);
                    }
                  } catch (deleteError) {
                    logger.error(`Failed to delete local file: ${filePath}`, undefined, { jobId, error: (deleteError as Error).message });
                    console.error(`Job ${jobId}: ❌ Failed to delete local file: ${path.basename(filePath)}`);
                  }
                }

                logger.info(`S3 uploads completed for job ${jobId}`, { jobId });
              } catch (s3Error: any) {
                logger.error(`S3 upload failed for job ${jobId}: ${s3Error.message}`, undefined, { 
                  jobId, 
                  error: s3Error.message
                });
                // Don't fail the entire job if S3 upload fails
                finalJobState.s3Error = s3Error.message;
              }
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
        
        // Convert to podcast episode if enabled
        if (isPodcastConversionEnabled && finalJobState.metadata) {
          try {
            console.log(`Job ${jobId}: Converting to podcast episode...`);
            
            // Determine audio URL (only use S3 location, no local fallback)
            let audioUrl = '';
            if (finalJobState.s3Locations?.audio?.location) {
              audioUrl = finalJobState.s3Locations.audio.location;
              console.log(`Job ${jobId}: Using S3 audio URL: ${audioUrl}`);
            } else {
              console.warn(`Job ${jobId}: No S3 audio location available for podcast conversion, skipping`);
              return; // Skip podcast conversion if no S3 URL available
            }
            
            // Determine video URL (only use S3 location, no local fallback)
            let videoUrl = '';
            if (finalJobState.s3Locations?.video?.location) {
              videoUrl = finalJobState.s3Locations.video.location;
              console.log(`Job ${jobId}: Using S3 video URL: ${videoUrl}`);
            } else {
              console.warn(`Job ${jobId}: No S3 video location available for podcast conversion`);
              // Continue with podcast conversion even without video URL as it's optional
            }
            
            // Create analysis configuration from environment variables
            const analysisConfig: AnalysisConfig = {
              topic_keywords: process.env.PODCAST_TOPIC_KEYWORDS?.split(',').map(k => k.trim()) || [],
              person_keywords: process.env.PODCAST_PERSON_KEYWORDS?.split(',').map(k => k.trim()) || [],
              enable_ai_analysis: process.env.PODCAST_AI_ANALYSIS_ENABLED === 'true'
            };
            
            // Convert and save as podcast episode
            const episodeId = await dynamoService.convertAndSaveAsPodcastEpisode(
              finalJobState.metadata,
              audioUrl,
              analysisConfig,
              videoUrl // Pass video URL as fourth parameter
            );
            
            if (episodeId) {
              console.log(`Job ${jobId}: Successfully converted to podcast episode ${episodeId}`);
              logger.info(`Podcast episode created`, { 
                jobId, 
                episodeId, 
                videoTitle: finalJobState.metadata.title,
                audioUrl,
                videoUrl
              });
            } else {
              console.warn(`Job ${jobId}: Failed to convert to podcast episode`);
              logger.warn(`Podcast episode conversion failed`, { jobId });
            }
          } catch (conversionError: any) {
            console.error(`Job ${jobId}: Podcast conversion error:`, conversionError);
            logger.error(`Podcast conversion failed for job ${jobId}: ${conversionError.message}`, undefined, { 
              jobId, 
              error: conversionError.message 
            });
            // Don't fail the entire job if podcast conversion fails
          }
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
      'DynamoDB Storage': isDynamoEnabled ? 'Enabled' : 'Disabled'
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

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
  VideoMetadata
} from './types.js';
import { 
  downloadVideoAudioOnlyWithProgress as downloadAudioNoVideoWithProgress, 
  downloadVideoNoAudioWithProgress, 
  getVideoMetadata,
  mergeVideoAudio,
  downloadAndMergeVideo
} from './lib/ytdlpWrapper.js';
import { isValidYouTubeUrl, sanitizeYouTubeUrl } from './lib/urlUtils.js';
import { checkAndUpdateYtdlp, getUpdateStatus, UpdateOptions } from './scripts/update_ytdlp.js';

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
      jobId: '',
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
 * Process download job asynchronously with video+audio merge
 */
async function processDownload(jobId: string, url: string): Promise<void> {
  let job = downloadJobs.get(jobId);
  if (!job) {
    console.warn(`Job ${jobId} not found at the start of processDownload.`);
    return;
  }

  try {
    // 1. Fetch Metadata
    job.status = 'downloading_metadata';
    if (!job.progress) {
        job.progress = {};
    }
    downloadJobs.set(jobId, { ...job });
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
      downloadJobs.set(jobId, { ...job });
      
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
        downloadJobs.set(jobId, { ...job });
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
    downloadJobs.set(jobId, { ...job }); 
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
        finalJobState.filePaths.mergedPath = path.basename(mergedFilePath); // Store relative filename
        finalJobState.status = 'completed';
        finalJobState.completedAt = new Date();
        
        // Final progress update
        if (!finalJobState.progress) finalJobState.progress = {};
        finalJobState.progress.merged = {
          percent: '100%',
          eta: '0s',
          speed: '',
          raw: 'Download and merge completed successfully!'
        };
        
        downloadJobs.set(jobId, { ...finalJobState });
        
        console.log(`Job ${jobId}: download and merge completed successfully.`);
        console.log(`Final merged file: ${mergedFilePath}`);
      }

    } catch (downloadError: any) {
      console.error(`Job ${jobId}: Download and merge failed:`, downloadError);
      const errorJobState = downloadJobs.get(jobId);
      if (errorJobState) {
        errorJobState.status = 'error';
        errorJobState.error = `Download and merge failed: ${downloadError?.message || String(downloadError)}`;
        errorJobState.completedAt = new Date();
        downloadJobs.set(jobId, { ...errorJobState });
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
      downloadJobs.set(jobId, { ...criticalFailureJob });
    }
  }
}

// Basic health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
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
    message: 'YouTube Video Download API',
    endpoints: {
      'POST /api/download': 'Start a new download job',
      'GET /api/job/:jobId': 'Get job status',
      'GET /api/jobs': 'Get all jobs',
      'DELETE /api/job/:jobId': 'Delete a job',
      'GET /api/search/:query': 'Search YouTube videos by title',
      'GET /health': 'Health check',
      'GET /downloads/*': 'Access downloaded files'
    },
    usage: {
      'Start Download': 'POST /api/download with { "url": "https://youtube.com/watch?v=..." }',
      'Check Status': 'GET /api/job/{jobId}',
      'List All Jobs': 'GET /api/jobs',
      'Search Videos': 'GET /api/search/{query}?maxResults=10',
      'Update yt-dlp': 'POST /api/update-ytdlp with { "nightly": true/false, "force": true/false }',
      'Update Status': 'GET /api/update-status'
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
    app.listen(PORT, () => {
      console.log(`🚀 YouTube Download Server running on port ${PORT}`);
      console.log(`📍 API Documentation: http://localhost:${PORT}/`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
      console.log(`📁 Downloads: http://localhost:${PORT}/downloads/`);
      console.log(`📦 Update Status: http://localhost:${PORT}/api/update-status`);
      console.log(`🔄 Manual Update: POST http://localhost:${PORT}/api/update-ytdlp`);
      console.log(`🌙 Using ${useNightly ? 'nightly' : 'stable'} yt-dlp builds`);
      console.log('✨ Server startup completed successfully');
    });
    
  } catch (error: any) {
    console.error('❌ Failed to start server:', error.message);
    console.error('💡 Server will start anyway, but yt-dlp might not be up to date');
    
    app.listen(PORT, () => {
      console.log(`🚀 YouTube Download Server running on port ${PORT} (with warnings)`);
      console.log(`📍 API Documentation: http://localhost:${PORT}/`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
      console.log(`📁 Downloads: http://localhost:${PORT}/downloads/`);
      console.log(`🌙 Using ${useNightly ? 'nightly' : 'stable'} yt-dlp builds`);
      console.log('⚠️ Server started with update check failure');
    });
  }
}

startServer();

export default app;

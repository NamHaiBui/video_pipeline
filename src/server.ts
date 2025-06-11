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
  mergeVideoAudio
} from './lib/ytdlpWrapper.js';
import { isValidYouTubeUrl, sanitizeYouTubeUrl } from './lib/urlUtils.js';

import dotenv from 'dotenv';

dotenv.config();

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
 * Starts a new download job for both video-only and audio-only files
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
 * Process download job asynchronously
 */
async function processDownload(jobId: string, url: string): Promise<void> {
  let job = downloadJobs.get(jobId);
  if (!job) {
    console.warn(`Job ${jobId} not found at the start of processDownload.`);
    return;
  }

  const tempFiles: string[] = [];

  try {
    // 1. Fetch Metadata
    job.status = 'downloading_metadata';
    // Ensure progress object exists
    if (!job.progress) {
        job.progress = {};
    }
    downloadJobs.set(jobId, { ...job }); // Update status in the map
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
      // Status will be changed to 'downloading' next, or 'error' if downloads fail.
      downloadJobs.set(jobId, { ...job }); // Save metadata
      const metadataFilename = `${jobId}_metadata.json`;
      const metadataPath = path.join(downloadsDir, metadataFilename);
      
      try {
        await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        console.log(`Job ${jobId}: Metadata saved to ${metadataPath}`);
        
        // Store metadata file path in job
        if (!job.filePaths) job.filePaths = {};
        job.filePaths.metadataPath = metadataFilename; // Store relative filename for download access
      } catch (writeError: any) {
        console.error(`Job ${jobId}: Failed to save metadata file:`, writeError);
        // Don't fail the entire job if metadata writing fails, just log it
      }
      console.log(`Job ${jobId}: Metadata fetched successfully.`);
    } catch (metaError: any) {
      console.error(`Job ${jobId}: Failed to fetch metadata:`, metaError);
      job = downloadJobs.get(jobId); // Re-fetch job
      if (job) {
        job.status = 'error';
        job.error = `Failed to fetch metadata: ${metaError?.message || String(metaError)}`;
        job.completedAt = new Date();
        downloadJobs.set(jobId, { ...job });
      }
      return; 
    }

    // 2. Proceed with File Downloads
    job = downloadJobs.get(jobId);
    if (!job || job.status === 'error') { 
        console.warn(`Job ${jobId} not found or in error state before starting file downloads.`);
        return;
    }
    
    job.status = 'downloading';
    if (!job.filePaths) job.filePaths = {};
    if (!job.progress) job.progress = {}; 

    downloadJobs.set(jobId, { ...job }); 
    console.log(`Job ${jobId}: Status changed to 'downloading'. Starting file downloads.`);

    const updateJobFilepath = (type: 'video' | 'audio', path: string) => {
        const currentJobState = downloadJobs.get(jobId);
        if (currentJobState) {
            if (!currentJobState.filePaths) currentJobState.filePaths = {};
            if (type === 'video') currentJobState.filePaths.videoPath = path;
            if (type === 'audio') currentJobState.filePaths.audioPath = path;
            downloadJobs.set(jobId, { ...currentJobState });
            console.log(`Job ${jobId}: ${type} download completed and path set: ${path}`);
        }
    };

    const videoDownloadPromise = downloadVideoNoAudioWithProgress(url, {
      onProgress: (progressInfo: ProgressInfo) => {
        const currentJobState = downloadJobs.get(jobId);
        if (currentJobState) {
          if (!currentJobState.progress) currentJobState.progress = {};
          currentJobState.progress.video = progressInfo;
          downloadJobs.set(jobId, { ...currentJobState });
        }
      }
    }).then(path => {
      updateJobFilepath('video', path);
      return path;
    });

    const audioDownloadPromise = downloadAudioNoVideoWithProgress(url, { // Using the alias
      onProgress: (progressInfo: ProgressInfo) => {
        const currentJobState = downloadJobs.get(jobId);
        if (currentJobState) {
          if (!currentJobState.progress) currentJobState.progress = {};
          currentJobState.progress.audio = progressInfo;
          downloadJobs.set(jobId, { ...currentJobState });
        }
      }
    }).then(path => {
      updateJobFilepath('audio', path);
      return path;
    });

    // Wait for both downloads to complete or fail
    const results = await Promise.allSettled([videoDownloadPromise, audioDownloadPromise]);
    
    const finalJobState = downloadJobs.get(jobId);
    if (!finalJobState) {
      console.warn(`Job ${jobId} not found when trying to finalize.`);
      return;
    }

    let overallSuccess = true;
    let errorMessages = finalJobState.error ? [finalJobState.error] : [];

    results.forEach((result, index) => {
      const type = index === 0 ? 'Video' : 'Audio';
      if (result.status === 'rejected') {
        overallSuccess = false;
        const reason = result.reason as Error;
        console.error(`Job ${jobId}: ${type} download failed in Promise.allSettled: ${reason?.message || String(reason)}`);
        errorMessages.push(`${type} download failed: ${reason?.message || String(reason)}`);
      } else {
        // Ensure file paths are set from fulfilled promises if not already by .then()
        // This should be redundant if .then() worked, but good for safety.
        if (index === 0 && !finalJobState.filePaths?.videoPath) {
            if(!finalJobState.filePaths) finalJobState.filePaths = {};
            finalJobState.filePaths.videoPath = result.value;
        }
        if (index === 1 && !finalJobState.filePaths?.audioPath) {
            if(!finalJobState.filePaths) finalJobState.filePaths = {};
            finalJobState.filePaths.audioPath = result.value;
        }
      }
    });

    if (overallSuccess && finalJobState.filePaths?.videoPath && finalJobState.filePaths?.audioPath) {
      finalJobState.status = 'completed';
      console.log(`Download job ${jobId} completed successfully.`);
      console.log(`Video: ${finalJobState.filePaths.videoPath}`);
      console.log(`Audio: ${finalJobState.filePaths.audioPath}`);
    } else {
      finalJobState.status = 'error';
      finalJobState.error = errorMessages.join('; ');
      console.error(`Download job ${jobId} finished with errors: ${finalJobState.error}`);
    }
    
    finalJobState.completedAt = new Date();
    downloadJobs.set(jobId, { ...finalJobState });

  } catch (error: any) { // Catch errors from synchronous parts or unhandled promise rejections
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
      'Search Videos': 'GET /api/search/{query}?maxResults=10'
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

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 YouTube Download Server running on port ${PORT}`);
  console.log(`📍 API Documentation: http://localhost:${PORT}/`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
  console.log(`📁 Downloads: http://localhost:${PORT}/downloads/`);
});

export default app;

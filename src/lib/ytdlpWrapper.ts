/**
 * YouTube-DL Wrapper with Enhanced Filename Sanitization
 * 
 * This module provides comprehensive filename sanitization for video/audio downloads:
 * 
 * 1. **Template Sanitization**: yt-dlp output templates are sanitized to prevent filesystem issues
 * 2. **Filename Safety**: Downloaded files are sanitized to be safe across different filesystems
 * 3. **Unicode Normalization**: Handles diacritics and special Unicode characters
 * 4. **Reserved Names**: Handles Windows reserved filenames (CON, PRN, AUX, etc.)
 * 5. **Length Limits**: Ensures filenames don't exceed filesystem limits
 * 6. **Path Safety**: Removes dangerous characters that could cause directory traversal
 * 
 * All download functions now include automatic sanitization of:
 * - Output filename templates
 * - Final download paths
 * - S3 key generation (via create_slug)
 */

import { execFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { VideoMetadata, ProgressInfo, DownloadOptions, CommandResult } from '../types.js';
import { S3Service, S3UploadResult, createS3ServiceFromEnv } from './s3Service.js';
import { createDynamoDBServiceFromEnv } from './dynamoService.js';
import { isValidYouTubeUrl } from './urlUtils.js';
import { generateAudioS3Key, generateVideoS3Key, getAudioBucketName, getVideoBucketName } from './s3KeyUtils.js';
import { sanitizeFilename, sanitizeOutputTemplate, create_slug } from './utils/utils.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths to Local Binaries ---
const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg');

// Default output directory for podcast downloads
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads');
const PODCAST_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads', 'podcasts');
const AUDIO_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads', 'audio');

// Ensure output directories exist
[DEFAULT_OUTPUT_DIR, PODCAST_OUTPUT_DIR, AUDIO_OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Sanitize and prepare output filename template for yt-dlp using slugs
 * Creates podcast-friendly slugified filenames in podcast-title/episode-name format
 */
function prepareOutputTemplate(template: string, metadata?: VideoMetadata, useSubdirectory: boolean = true): string {
  const sanitizedTemplate = sanitizeOutputTemplate(template);
  
  // If we have metadata and should use subdirectory structure,
  // create slugified template in podcast-title/episode-name format
  if (metadata && useSubdirectory) {
    const podcastTitleSlug = create_slug(metadata.uploader || 'unknown');
    const episodeTitleSlug = create_slug(metadata.title || 'untitled');
    
    // Create podcast-friendly filename structure: podcast-title/episode-name.ext
    return `${podcastTitleSlug}/${episodeTitleSlug}.%(ext)s`;
  }
  
  return sanitizedTemplate;
}

/**
 * Handle download path detection and sanitization
 */
function sanitizeDownloadPath(path: string): string {
  if (!path) return path;
  
  // Split path into directory and filename
  const dir = path.substring(0, path.lastIndexOf('/') + 1);
  const filename = path.substring(path.lastIndexOf('/') + 1);
  
  // Sanitize the filename part only
  const sanitizedFilename = sanitizeFilename(filename);
  
  return dir + sanitizedFilename;
}

/**
 * Checks if the required binaries exist and are executable.
 */
function checkBinaries(): void {
  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error(`yt-dlp not found at ${YTDLP_PATH}. Run 'npm run setup' or 'npm install'.`);
  }
  if (!fs.existsSync(FFMPEG_PATH)) {
    throw new Error(`ffmpeg not found at ${FFMPEG_PATH}. Run 'npm run setup' or 'npm install'.`);
  }
}

/**
 * Get optimal audio format for podcast content
 */
function getPodcastAudioFormat(): string {
  const preferredFormat = process.env.PREFERRED_AUDIO_FORMAT || 'mp3';
  
  // Podcast-optimized format selection
  switch (preferredFormat.toLowerCase()) {
    case 'opus':
      return 'bestaudio[ext=opus]/bestaudio[acodec=opus]/bestaudio';
    case 'aac':
      return 'bestaudio[ext=aac]/bestaudio[acodec=aac]/bestaudio';
    case 'm4a':
      return 'bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio';
    default:
      return 'bestaudio[ext=mp3]/bestaudio[acodec=mp3]/bestaudio';
  }
}

/**
 * Build standardized yt-dlp arguments with client configuration
 */
function buildYtdlpArgs(
  videoUrl: string,
  outputPathAndFilename: string,
  format: string,
  options: DownloadOptions = {cookiesFile: '.config/yt-dlp/yt-dlp-cookies.txt'},
  additionalArgs: string[] = []
): string[] {
  let baseArgs = [
    videoUrl,
    '-o', outputPathAndFilename,
    '-f', format,
    '-v',
    '--plugin-dirs','.config/yt-dlp/plugins/',
    '-N', '8',
    '--progress',
    '--progress-template', 'download-status:%(progress._percent_str)s ETA %(progress.eta)s SPEED %(progress.speed)s TOTAL %(progress.total_bytes_str)s',
    '--no-continue',
    ...additionalArgs
  ];

  // Add ffmpeg location if available
  if (fs.existsSync(FFMPEG_PATH)) {
    baseArgs.unshift('--ffmpeg-location', FFMPEG_PATH);
  }

  // Add cookies file if specified and exists
  if (options.cookiesFile && fs.existsSync(options.cookiesFile)) {
    baseArgs.push('--cookies', options.cookiesFile);
  } else if (options.cookiesFile) {
    logger.warn('Cookies file not found, proceeding without it', { cookiesFile: options.cookiesFile });
  }
  // browserHeaders.forEach(header => {
  //   baseArgs.push('--add-header', header);
  // });
  // Add additional headers if specified
  if (options.additionalHeaders) {
    options.additionalHeaders.forEach(header => {
      baseArgs.push('--add-header', header);
    });
  }

  return baseArgs;
}

/**
 * Handle progress parsing in a standardized way
 */
function handleProgressData(line: string, options: DownloadOptions): void {
  if (line.startsWith('download-status:')) {
    const progressData = line.replace('download-status:', '').trim();
    const parts = progressData.match(/([\d.]+\%) ETA (.+?) SPEED (.+?) TOTAL (.+)/);
    
    if (options.onProgress && parts) {
      options.onProgress({
        percent: parts[1].trim(),
        eta: parts[2].trim(),
        speed: parts[3].trim(),
        total: parts[4].trim(),
        raw: progressData
      });
    } else if (options.onProgress) {
      options.onProgress({
        percent: '',
        eta: '',
        speed: '',
        raw: progressData
      });
    } else {
      logger.debug('Progress received', { progressData });
    }
  }
}

/**
 * Handle download completion detection in a standardized way
 */
function handleDownloadPath(line: string): string | null {
  if (line.includes('[ExtractAudio]') || line.includes('[Merger]') || line.includes('[download] Destination:')) {
    const match = line.match(/Destination: (.*)/) || line.match(/Merging formats into "(.*)"/);
    if (match && match[1]) {
      const rawPath = match[1].trim();
      return sanitizeDownloadPath(rawPath);
    }
  }
  return null;
}

/**
 * Generic function to execute a yt-dlp download process and handle its events.
 */
function executeDownloadProcess(
  args: string[],
  options: DownloadOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    logger.debug('Executing yt-dlp command', { command: `${YTDLP_PATH} ${args.join(' ')}` });
    const ytdlpProcess = spawn(YTDLP_PATH, args);
    let downloadedFilePath = '';
    let stderrOutput = '';

    ytdlpProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      handleProgressData(line, options);
      
      const detectedPath = handleDownloadPath(line);
      if (detectedPath) {
        downloadedFilePath = detectedPath;
      }
      if (line && !line.startsWith('download-status:')) {
        logger.debug('yt-dlp stdout', { line });
      }
    });

    ytdlpProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      stderrOutput += line + '\n';
      
      // Only log actual errors and warnings, filter out informational messages
      const lowerLine = line.toLowerCase();
      const isInformational = lowerLine.includes('downloading webpage') ||
                             lowerLine.includes('extracting data') ||
                             lowerLine.includes('has already been downloaded') ||
                             lowerLine.includes('[youtube]') ||
                             lowerLine.includes('selected format') ||
                             lowerLine.includes('resuming download');
                             
      const isActualWarning = lowerLine.includes('error') || 
                             lowerLine.includes('warning') || 
                             lowerLine.includes('failed') || 
                             lowerLine.includes('timeout') ||
                             lowerLine.includes('unavailable');
      
      if (isActualWarning && !isInformational) {
        logger.warn('yt-dlp stderr', { line });
      } else {
        logger.debug('yt-dlp info', { line });
      }
    });

    ytdlpProcess.on('error', (error: Error) => {
      logger.error('Failed to start yt-dlp process', error);
      reject(error);
    });

    ytdlpProcess.on('close', (code: number | null) => {
      if (code === 0) {
        if (options.onProgress) {
          options.onProgress({
            percent: '100%',
            eta: '0s',
            speed: '',
            raw: 'Download Complete'
          });
        }
        const finalPath = downloadedFilePath || 'unknown_path';
        logger.info('Download finished successfully', { finalPath, exitCode: code });
        resolve(finalPath);
      } else {
        const errorMessage = `yt-dlp process exited with code ${code}.`;
        logger.error('Download failed', new Error(errorMessage), { stderrOutput });
        reject(new Error(`${errorMessage}\nStderr: ${stderrOutput}`));
      }
    });
  });
}

export async function getVideoMetadata(videoUrl: string, options: DownloadOptions = {cookiesFile: '.config/yt-dlp/yt-dlp-cookies.txt'}): Promise<VideoMetadata> {
  checkBinaries();
  let args = [
    '--dump-json',
    '--no-warnings',
    '--plugin-dirs','.config/yt-dlp/plugins/',
  ];

  // Add ffmpeg location if available
  if (fs.existsSync(FFMPEG_PATH)) {
    args.unshift('--ffmpeg-location', FFMPEG_PATH);
  }

  // Add cookies file if specified and exists
  if (options.cookiesFile && fs.existsSync(options.cookiesFile)) {
    args.push('--cookies', options.cookiesFile);
  } else if (options.cookiesFile) {
    logger.warn('Cookies file not found, proceeding without it', { cookiesFile: options.cookiesFile });
  }

  // Add additional headers if specified
  if (options.additionalHeaders) {
    options.additionalHeaders.forEach(header => {
      args.push('--add-header', header);
    });
  }

  args.push(videoUrl);

  logger.info('Fetching video metadata', { url: videoUrl });
  logger.debug('Executing yt-dlp metadata command', { command: `${YTDLP_PATH} ${args.join(' ')}` });
  
  try {
    const { stdout, stderr } = await new Promise<CommandResult>((resolve, reject) => {
      execFile(YTDLP_PATH, args, (error, stdout, stderr) => {
        if (error) {
          logger.error('yt-dlp execution error', error, { stderr });
          // Don't double-log stderr if it's already been logged above
          (error as any).stderrContent = stderr;
          return reject(error);
        }
        resolve({ stdout, stderr });
      });
    });

    // Only log stderr if it contains actual warnings/errors, not just info messages
    if (stderr) {
      const lowerStderr = stderr.toLowerCase();
      const isInformational = lowerStderr.includes('downloading webpage') ||
                             lowerStderr.includes('extracting data') ||
                             lowerStderr.includes('has already been downloaded') ||
                             lowerStderr.includes('[youtube]') ||
                             lowerStderr.includes('selected format') ||
                             lowerStderr.includes('resuming download');
                             
      const isActualWarning = lowerStderr.includes('error') || 
                             lowerStderr.includes('warning') || 
                             lowerStderr.includes('failed') || 
                             lowerStderr.includes('timeout') ||
                             lowerStderr.includes('unavailable');
      
      if (isActualWarning && !isInformational) {
        logger.warn('yt-dlp warnings during metadata fetch', { stderr: stderr.trim() });
      } else if (!isInformational) {
        logger.debug('yt-dlp info during metadata fetch', { stderr: stderr.trim() });
      }
    }
    
    try {
      const metadata = JSON.parse(stdout) as VideoMetadata;
      
      // Note: Video metadata is no longer uploaded to DynamoDB
      // Only podcast episode metadata will be uploaded during audio processing
      logger.info('Video metadata extracted successfully');
      
      return metadata;
    } catch (parseError: any) {
      logger.error('Failed to parse JSON metadata', parseError, { url: videoUrl, stdout: stdout.substring(0, 200) });
      throw new Error(`Failed to parse JSON metadata for ${videoUrl}. Raw output: ${stdout.substring(0, 200)}...`);
    }
  } catch (error: any) {
    logger.error('Failed to fetch or parse metadata', error, { url: videoUrl });
    if (error.stderrContent) {
        logger.error('Detailed yt-dlp error output', undefined, { stderr: error.stderrContent });
    }
    throw error;
  }
}

export function downloadPodcastAudioWithProgress(videoUrl: string, options: DownloadOptions = {}, metadata?: VideoMetadata): Promise<string> {
  checkBinaries();
  return new Promise(async (resolve, reject) => {
    const outputDir = options.outputDir || PODCAST_OUTPUT_DIR;
    let outputFilenameTemplate = options.outputFilename || 'unknown-podcast/untitled-episode.%(ext)s';
    const format = options.format || getPodcastAudioFormat();
    
    // Use provided metadata or fetch it once
    let videoMetadata = metadata;
    if (!videoMetadata) {
      try {
        videoMetadata = await getVideoMetadata(videoUrl, options);
      } catch (metaError) {
        logger.warn('Could not fetch metadata for filename optimization, using template as-is', { error: metaError });
      }
    }
    
    // Prepare output template with metadata if available
    if (videoMetadata) {
      outputFilenameTemplate = prepareOutputTemplate(outputFilenameTemplate, videoMetadata, true); // Use subdirectory for final files
    }
    
    // Ensure the directory structure exists for the podcast-title subdirectory
    const templatePath = path.join(outputDir, outputFilenameTemplate);
    const templateDir = path.dirname(templatePath);
    if (!fs.existsSync(templateDir)) {
        fs.mkdirSync(templateDir, { recursive: true });
    }
    
    const outputPathAndFilename = templatePath;
    
    const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options, ['-x']);

    logger.info('Starting podcast audio download', { url: videoUrl, format });
    logger.debug('Using audio format', { format });

    try {
      const finalPath = await executeDownloadProcess(baseArgs, {
        ...options,
        onProgress: (progress) => {
          if (options.onProgress) {
            options.onProgress({
              ...progress,
              raw: progress.raw === 'Download Complete' ? 'Podcast Audio Download Complete' : progress.raw
            });
          }
        }
      });
      
      // Upload to S3 if enabled
      if (options.s3Upload?.enabled) {
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            logger.info('Uploading podcast audio to S3');
            
            let audioKey: string;
            if (videoMetadata) {
              audioKey = generateAudioS3Key(videoMetadata);
            } else {
              // Fallback naming
              const filename = path.basename(finalPath);
              audioKey = `podcasts/audio/${filename}`;
            }
            
            const bucketName = getAudioBucketName();
            const uploadResult = await s3Service.uploadFile(finalPath, bucketName, audioKey);
            
            if (uploadResult.success) {
              logger.info('Podcast audio uploaded to S3 successfully', { location: uploadResult.location });
              
              // Only delete local file if deleteLocalAfterUpload is not explicitly set to false
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalPath);
                  logger.info('Deleted local audio file after S3 upload', { filename: path.basename(finalPath) });
                } catch (deleteError) {
                  logger.warn('Failed to delete local audio file', { error: deleteError, filename: path.basename(finalPath) });
                }
              } else {
                logger.info('Keeping local audio file for further processing', { filename: path.basename(finalPath) });
              }
            } else {
              logger.error('Failed to upload podcast audio to S3', undefined, { error: uploadResult.error });
            }
          } else {
            logger.warn('S3 service not available, skipping upload');
          }
        } catch (error: any) {
          logger.error('Error during S3 upload', error);
        }
      }
      
      resolve(finalPath);
    } catch (error) {
      reject(error);
    }
  });
}
export function downloadVideoNoAudioWithProgress(videoUrl: string, options: DownloadOptions = {}, metadata?: VideoMetadata): Promise<string> {
    checkBinaries();
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    let outputFilenameTemplate = options.outputFilename || 'unknown-podcast/untitled-episode.%(ext)s';
    const format = options.format || 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]/bestvideo[ext=mp4]/best[ext=mp4]/best';

    // Prepare output template with metadata if available
    if (metadata) {
      outputFilenameTemplate = prepareOutputTemplate(outputFilenameTemplate, metadata, false); // Don't use subdirectory for temp files
    }
    
    // Ensure the directory structure exists for the podcast-title subdirectory
    const templatePath = path.join(outputDir, outputFilenameTemplate);
    const templateDir = path.dirname(templatePath);
    if (!fs.existsSync(templateDir)) {
        fs.mkdirSync(templateDir, { recursive: true });
    }
    
    const outputPathAndFilename = templatePath;

    const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options);

    logger.info(`Starting video-only download for: ${videoUrl}`);
    return executeDownloadProcess(baseArgs, options);
}

/**
 * Helper function to upload audio to S3
 */
async function uploadAudioToS3(localPath: string, videoUrl: string, s3Service: S3Service, metadata?: VideoMetadata): Promise<S3UploadResult | null> {
  if (!s3Service || !isValidYouTubeUrl(videoUrl)) {
    if (!s3Service) logger.warn('S3 service not available, skipping upload.');
    return null;
  }

  logger.info('🚀 Uploading audio to S3...');
  
  // Use provided metadata or fallback to fetching it
  let videoMetadata = metadata;
  if (!videoMetadata) {
    try {
      videoMetadata = await getVideoMetadata(videoUrl);
    } catch (metaError) {
      logger.warn('Could not fetch metadata for S3 naming, using fallback', { error: metaError });
    }
  }

  const s3AudioKey = videoMetadata ? generateAudioS3Key(videoMetadata) : `audio/audio_${Date.now()}.mp3`;
  const bucketName = getAudioBucketName();
  const uploadResult = await s3Service.uploadFile(localPath, bucketName, s3AudioKey);

  if (uploadResult.success) {
    logger.info(`✅ Audio uploaded to S3: ${uploadResult.location}`);
    return uploadResult;
  } else {
    logger.error(`❌ Failed to upload audio to S3: ${uploadResult.error}`);
    return null;
  }
}

/**
 * Download video and audio separately, then merge them into a single file
 */
export function downloadAndMergeVideo(videoUrl: string, options: DownloadOptions = {}, metadata?: VideoMetadata): Promise<{ mergedFilePath: string, episodeId:string}> {
  checkBinaries();
  return new Promise(async (resolve, reject) => {
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    let outputFilenameTemplate = options.outputFilename || 'unknown-podcast/untitled-episode.%(ext)s';
    
    // Use provided metadata or fetch it once
    let videoMetadata = metadata;
    if (!videoMetadata) {
      try {
        videoMetadata = await getVideoMetadata(videoUrl, options);
      } catch (metaError) {
        logger.warn('Could not fetch metadata for filename sanitization, using template as-is');
      }
    }
    
    // Prepare output template with metadata if available
    if (videoMetadata) {
      outputFilenameTemplate = prepareOutputTemplate(outputFilenameTemplate, videoMetadata, true); // Use subdirectory for final files
    }
    
    // Ensure the directory structure exists for the podcast-title subdirectory
    const templatePath = path.join(outputDir, outputFilenameTemplate);
    const templateDir = path.dirname(templatePath);
    if (!fs.existsSync(templateDir)) {
        fs.mkdirSync(templateDir, { recursive: true });
    }
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const tempDir = path.join(outputDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let tempVideoPath = '';
    let tempAudioPath = '';
    let finalMergedPath = '';

    try {
      logger.info(`Starting video+audio download and merge for: ${videoUrl}`);
      logger.info('Starting parallel download of video and audio streams...');
      
      // Create slug-based temporary filenames
      const podcastSlug = videoMetadata ? create_slug(videoMetadata.uploader || 'unknown') : 'unknown-podcast';
      const episodeSlug = videoMetadata ? create_slug(videoMetadata.title || 'untitled') : 'untitled-episode';
      const timestamp = Date.now();
      
      const videoDownloadPromise = downloadVideoNoAudioWithProgress(videoUrl, {
        ...options,
        outputDir: tempDir,
        outputFilename: `video_${timestamp}_${podcastSlug}_${episodeSlug}.%(ext)s`,
        onProgress: (progress: ProgressInfo) => {
          if (options.onProgress) {
            options.onProgress({
              ...progress,
              raw: `Video: ${progress.raw}`
            });
          }
        }
      }, videoMetadata);

      const audioDownloadPromise = downloadPodcastAudioWithProgress(videoUrl, {
        ...options,
        outputDir: tempDir,
        outputFilename: `audio_${timestamp}_${podcastSlug}_${episodeSlug}.%(ext)s`,
        s3Upload: options.s3Upload ? {
          ...options.s3Upload,
          deleteLocalAfterUpload: false // Keep audio file for merging
        } : undefined,
        onProgress: (progress: ProgressInfo) => {
          if (options.onProgress) {
            options.onProgress({
              ...progress,
              raw: `Audio: ${progress.raw}`
            });
          }
        }
      }, videoMetadata);



      // Handle audio download separately to upload immediately when it's done
      var uploadedAudioInfo:S3UploadResult|null = null;
      let episodeId = '';
      
      const audioPromise = audioDownloadPromise.then(async (audioPath: string) => {
        tempAudioPath = audioPath;
        logger.info(`Audio download completed successfully: ${audioPath}`);
                
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            uploadedAudioInfo = await uploadAudioToS3(audioPath, videoUrl, s3Service, videoMetadata || undefined);
            if (uploadedAudioInfo && options.onProgress) {
              options.onProgress({
                percent: '100%',
                eta: '0s',
                speed: '',
                raw: 'Audio: Upload to S3 completed!'
              });
            }
          }
        } catch (error: any) {
          logger.error(`❌ Error uploading audio to S3: ${error.message}`);
        }
        
        // Process metadata and save podcast episode data to DynamoDB when audio is finished
        // Note: Only podcast episode metadata is uploaded, not raw video metadata
        try {
          const dynamoService = createDynamoDBServiceFromEnv();
          if (dynamoService && videoMetadata && uploadedAudioInfo?.location) {
            logger.info('💾 Processing and saving podcast episode metadata...');
            const podcastEpisode = dynamoService.processEpisodeMetadata(videoMetadata, uploadedAudioInfo.key || uploadedAudioInfo.location);
            episodeId = podcastEpisode.id;
            
            // Save the podcast episode to DynamoDB
            const saveSuccess = await dynamoService.savePodcastEpisode(podcastEpisode);
            if (saveSuccess) {
              logger.info(`✅ Podcast episode metadata saved successfully: ${episodeId}`);
            } else {
              logger.warn(`⚠️ Failed to save podcast episode metadata: ${episodeId}`);
            }
          } else {
            logger.warn('⚠️ DynamoDB service not available, metadata missing, or audio upload failed - skipping podcast episode metadata processing');
          }
        } catch (error: any) {
          logger.error(`❌ Error processing podcast episode metadata: ${error.message}`);
        }
        
        return episodeId;
      });
      
      // Wait for video download
      tempVideoPath = await videoDownloadPromise;
      episodeId = await audioPromise;
      
      logger.info('Both downloads processed successfully!');
      logger.info(`Video: ${tempVideoPath}`);
      logger.info(`Audio: ${tempAudioPath}`);
      
      // Store the audio path and upload info for later use

      // Generate final merged file path using slug-based naming
      if (videoMetadata) {
        const podcastSlug = create_slug(videoMetadata.uploader || 'unknown');
        const episodeSlug = create_slug(videoMetadata.title || 'untitled');
        
        // Create the podcast directory if it doesn't exist
        const podcastDir = path.join(outputDir, podcastSlug);
        if (!fs.existsSync(podcastDir)) {
          fs.mkdirSync(podcastDir, { recursive: true });
        }
        
        finalMergedPath = path.join(podcastDir, `${episodeSlug}.mp4`);
      } else if (options.outputFilename) {
        const sanitizedCustomFilename = sanitizeFilename(options.outputFilename.replace('%(ext)s', 'mp4'));
        finalMergedPath = path.join(outputDir, sanitizedCustomFilename);
      } else {
        const timestamp = Date.now();
        finalMergedPath = path.join(outputDir, `merged_video_${timestamp}.mp4`);
      }

      logger.info('Starting merge of video and audio streams...');
      if (options.onProgress) {
        options.onProgress({
          percent: '95%',
          eta: '0s',
          speed: '',
          raw: 'Merging video and audio...'
        });
      }

      // Merge video and audio with validation
      await mergeVideoAudioWithValidation(tempVideoPath, tempAudioPath, finalMergedPath, options);

      logger.info('Cleaning up temporary files...');
      try {
        if (fs.existsSync(tempVideoPath)) {
          await fsPromises.unlink(tempVideoPath);
          logger.info('✅ Cleaned up temporary video file');
        }
        if (fs.existsSync(tempAudioPath)) {
          await fsPromises.unlink(tempAudioPath);
          logger.info('✅ Cleaned up temporary audio file');
        }
        
        // Clean up empty directories starting from where the files were
        const tempVideoDir = path.dirname(tempVideoPath);
        const tempAudioDir = path.dirname(tempAudioPath);
        
        if (tempVideoDir === tempAudioDir) {
          // Same directory for both files
          await cleanupEmptyDirectories(tempVideoDir);
        } else {
          // Different directories
          await cleanupEmptyDirectories(tempVideoDir);
          await cleanupEmptyDirectories(tempAudioDir);
        }
        
        // Clean up the main temp directory if it's empty
        await cleanupEmptyDirectories(tempDir);
      } catch (cleanupError) {
        logger.warn('Warning: Failed to clean up temporary files', { error: cleanupError });
      }

      if (options.onProgress) {
        options.onProgress({
          percent: '100%',
          eta: '0s',
          speed: '',
          raw: 'Download and merge complete!'
        });
      }

      const resultObj = {
        mergedFilePath: finalMergedPath,
        episodeId: episodeId,
      };
      
      
      logger.info(`Video download and merge completed successfully: ${resultObj.mergedFilePath}`);
      
      if (options.s3Upload?.enabled) {
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            logger.info('🚀 Uploading merged video file to S3...');
            
            // Use already retrieved metadata instead of making another network call
            let videoKey: string;
            if (videoMetadata) {
              const videoExtension = path.extname(finalMergedPath);
              videoKey = generateVideoS3Key(videoMetadata, videoExtension);
            } else {
              // Fallback naming
              const filename = path.basename(finalMergedPath);
              videoKey = `video/${filename}`;
            }
            
            const bucketName = getVideoBucketName();
            const uploadResult = await s3Service.uploadFile(finalMergedPath, bucketName, videoKey);
            
            if (uploadResult.success) {
              logger.info(`✅ Video uploaded to S3: ${uploadResult.location}`);
              // Update DynamoDB with video S3 key
              try {
                const dynamoService = createDynamoDBServiceFromEnv();
                if (dynamoService && episodeId && videoKey) {
                  logger.info('💾 Updating episode with video S3 key...');
                  const updateSuccess = await dynamoService.updateEpisodeVideoLink(episodeId, videoKey);
                  if (updateSuccess) {
                    logger.info(`✅ Episode ${episodeId} updated with video S3 key`);
                  } else {
                    logger.warn(`⚠️ Failed to update episode ${episodeId} with video S3 key`);
                  }
                }
              } catch (updateError: any) {
                logger.warn('⚠️ DynamoDB video key update error:', updateError.message);
              }
              
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== true;
              if (shouldDeleteLocal) {
                try {
                // await s3Service.deleteLocalFile(audio);
                  await s3Service.deleteLocalFile(finalMergedPath);
                  logger.info(`🗑️ Deleted local video file after S3 upload: ${path.basename(finalMergedPath)}`);
                } catch (deleteError) {
                  logger.warn(`⚠️ Failed to delete local video file: ${deleteError}`);
                }
              } else {
                logger.info(`📁 Keeping local video file: ${path.basename(finalMergedPath)}`);
              }
            } else {
              logger.error(`❌ Failed to upload video to S3: ${uploadResult.error}`);
            }
          } else {
            logger.warn('⚠️ S3 service not available, skipping upload');
          }
        } catch (error: any) {
          logger.error('❌ Error during S3 video upload:', error.message);
        }
      }
      
      resolve(resultObj);

    } catch (error: any) {
      logger.error(`Error during download and merge process: ${error.message}`);
      
      // Clean up temp files on error
      try {
        if (tempVideoPath && fs.existsSync(tempVideoPath)) {
          await fsPromises.unlink(tempVideoPath);
        }
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
          await fsPromises.unlink(tempAudioPath);
        }
        
        // Clean up empty directories on error as well
        if (tempVideoPath && tempAudioPath) {
          const tempVideoDir = path.dirname(tempVideoPath);
          const tempAudioDir = path.dirname(tempAudioPath);
          
          if (tempVideoDir === tempAudioDir) {
            await cleanupEmptyDirectories(tempVideoDir);
          } else {
            await cleanupEmptyDirectories(tempVideoDir);
            await cleanupEmptyDirectories(tempAudioDir);
          }
        }
      } catch (cleanupError) {
        logger.warn('Warning: Failed to clean up temporary files after error', { error: cleanupError });
      }
      
      reject(error);
    }
  });
}
/**
 * Enhanced mergeVideoAudio function with validation
 */
export function mergeVideoAudioWithValidation(videoPath: string, audioPath: string, outputPath: string, _options: DownloadOptions = {}): Promise<string> {
  checkBinaries();
  
  return new Promise((resolve, reject) => {
    // Pre-merge validation
    if (!fs.existsSync(videoPath)) {
      logger.error(`❌ Video file missing: ${videoPath}`);
      // List files in the directory to help with debugging
      const videoDir = path.dirname(videoPath);
      if (fs.existsSync(videoDir)) {
        const files = fs.readdirSync(videoDir);
        logger.debug('Files in video directory', { directory: videoDir, files });
      } else {
        logger.error(`📁 Directory ${videoDir} does not exist`);
      }
      return reject(new Error(`Video file does not exist: ${videoPath}`));
    }
    if (!fs.existsSync(audioPath)) {
      logger.error(`❌ Audio file missing: ${audioPath}`);
      // List files in the directory to help with debugging
      const audioDir = path.dirname(audioPath);
      if (fs.existsSync(audioDir)) {
        const files = fs.readdirSync(audioDir);
        logger.debug('Files in audio directory', { directory: audioDir, files });
      } else {
        logger.error(`📁 Directory ${audioDir} does not exist`);
      }
      return reject(new Error(`Audio file does not exist: ${audioPath}`));
    }

    const videoStats = fs.statSync(videoPath);
    const audioStats = fs.statSync(audioPath);
    
    if (videoStats.size === 0) {
      return reject(new Error(`Video file is empty: ${videoPath}`));
    }
    if (audioStats.size === 0) {
      return reject(new Error(`Audio file is empty: ${audioPath}`));
    }

    logger.info(`📹 Video file: ${(videoStats.size / 1024 / 1024).toFixed(2)} MB`);
    logger.info(`🔊 Audio file: ${(audioStats.size / 1024 / 1024).toFixed(2)} MB`);

    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-y',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      outputPath
    ];

    logger.info(`Merging video and audio: ${FFMPEG_PATH} ${args.join(' ')}`);

    const ffmpegProcess = spawn(FFMPEG_PATH, args);
    let ffmpegOutput = '';
    let ffmpegError = '';

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      ffmpegError += output + '\n';
      logger.info(`ffmpeg: ${output}`);
    });

    ffmpegProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      ffmpegOutput += output + '\n';
      logger.info(`ffmpeg stdout: ${output}`);
    });

    ffmpegProcess.on('error', (error: Error) => {
      logger.error(`Failed to start ffmpeg process: ${error.message}`);
      reject(error);
    });

    ffmpegProcess.on('close', (code: number | null) => {
      if (code === 0) {
        // Post-merge validation
        if (!fs.existsSync(outputPath)) {
          return reject(new Error(`Merged file was not created: ${outputPath}`));
        }

        const mergedStats = fs.statSync(outputPath);
        if (mergedStats.size === 0) {
          return reject(new Error(`Merged file is empty: ${outputPath}`));
        }

        logger.info(`✅ Merge completed successfully. Output: ${outputPath}`);
        logger.info(`📁 Merged file size: ${(mergedStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        resolve(outputPath);
      } else {
        logger.error(`❌ ffmpeg process exited with error code ${code}`);
        logger.error(`ffmpeg error output: ${ffmpegError}`);
        reject(new Error(`ffmpeg process exited with code ${code}. Error: ${ffmpegError}`));
      }
    });
  });
}

/**
 * Recursively clean up empty directories
 */
async function cleanupEmptyDirectories(dirPath: string, stopAtRoot: string = DEFAULT_OUTPUT_DIR): Promise<void> {
  try {
    if (!fs.existsSync(dirPath) || dirPath === stopAtRoot) {
      return;
    }
    
    const files = await fsPromises.readdir(dirPath);
    
    if (files.length === 0) {
      await fsPromises.rmdir(dirPath);
      logger.info(`🗑️ Removed empty directory: ${path.basename(dirPath)}`);
      
      // Recursively clean up parent directory if it's now empty
      const parentDir = path.dirname(dirPath);
      if (parentDir !== stopAtRoot && parentDir !== dirPath) {
        await cleanupEmptyDirectories(parentDir, stopAtRoot);
      }
    }
  } catch (error: any) {
    logger.warn(`Warning: Failed to clean up directory ${dirPath}:`, error.message);
  }
}
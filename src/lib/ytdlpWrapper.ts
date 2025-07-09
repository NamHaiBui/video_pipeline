import { execFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { VideoMetadata, ProgressInfo, DownloadOptions, CommandResult, SQSJobMessage } from '../types.js';
import { S3Service, S3UploadResult, createS3ServiceFromEnv } from './s3Service.js';
import { RDSService, SQSMessageBody, EpisodeRecord } from './rdsService.js';
import { isValidYouTubeUrl } from './urlUtils.js';
import { generateAudioS3Key, generateVideoS3Key, getAudioBucketName, getVideoBucketName } from './s3KeyUtils.js';
import { sanitizeFilename, sanitizeOutputTemplate, create_slug } from './utils/utils.js';
import { logger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Utility functions for RDS migration
function generateEpisodeId(): string {
  return uuidv4();
}

function parseVideoDate(dateString: string): Date | null {
  if (!dateString) return null;
  
  try {
    // Handle YouTube date format (YYYYMMDD)
    if (/^\d{8}$/.test(dateString)) {
      const year = dateString.substring(0, 4);
      const month = dateString.substring(4, 6);
      const day = dateString.substring(6, 8);
      return new Date(`${year}-${month}-${day}`);
    }
    
    // Try parsing the string normally
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    logger.error(`Failed to parse date: ${dateString}`, error as Error);
    return null;
  }
}

// --- Paths to Local Binaries ---
const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg');

// Default output directory for podcast downloads
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads');
const PODCAST_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads', 'podcasts');
const AUDIO_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads', 'audio');

// Default cookies file path
const DEFAULT_COOKIES_FILE = path.resolve(__dirname, '..', '..', '.config', 'yt-dlp', 'yt-dlp-cookies.txt');

// Ensure output directories exist
[DEFAULT_OUTPUT_DIR, PODCAST_OUTPUT_DIR, AUDIO_OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Log cookies file initialization
logger.info('Initializing ytdlpWrapper', {
  defaultCookiesFile: DEFAULT_COOKIES_FILE,
  cookiesFileExists: fs.existsSync(DEFAULT_COOKIES_FILE),
  workingDirectory: process.cwd(),
  moduleDirectory: __dirname
});

/**
 * Resolve the cookies file path to an absolute path
 * @param cookiesFile - The cookies file path (can be relative or absolute)
 * @returns Absolute path to the cookies file
 */
function resolveCookiesFilePath(cookiesFile: string): string {
  logger.debug('Resolving cookies file path', { 
    inputPath: cookiesFile,
    isAbsolute: path.isAbsolute(cookiesFile),
    currentDir: __dirname,
    projectRoot: path.resolve(__dirname, '..', '..')
  });

  if (path.isAbsolute(cookiesFile)) {
    logger.debug('Using absolute cookies file path', { cookiesFile });
    return cookiesFile;
  }
  
  // If it's a relative path, resolve it relative to the project root
  const resolvedPath = path.resolve(__dirname, '..', '..', cookiesFile);
  logger.debug('Resolved relative cookies file path', { 
    inputPath: cookiesFile,
    resolvedPath,
    exists: fs.existsSync(resolvedPath)
  });
  
  return resolvedPath;
}

/**
 * Ensure that DownloadOptions always includes cookies file
 * @param options - The original DownloadOptions
 * @returns DownloadOptions with cookies file guaranteed to be set
 */
function ensureCookiesInOptions(options: DownloadOptions = {}): DownloadOptions {
  const optionsWithCookies = { ...options };
  
  // Always set cookies file if not provided
  if (!optionsWithCookies.cookiesFile) {
    optionsWithCookies.cookiesFile = DEFAULT_COOKIES_FILE;
    logger.debug('Auto-setting default cookies file', { cookiesFile: DEFAULT_COOKIES_FILE });
  }
  
  return optionsWithCookies;
}

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
  options: DownloadOptions = {},
  additionalArgs: string[] = []
): string[] {
  // Ensure cookies are always included
  const optionsWithCookies = ensureCookiesInOptions(options);
  
  let baseArgs = [
    videoUrl,
    '-o', outputPathAndFilename,
    '-f', format,
    '-v',
    '--plugin-dirs','./.config/yt-dlp/plugins/',
    '-N', '4',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_PROVIDER_URL || 'http://bgutil-provider:4416'}`,
    '--no-continue',
    ...additionalArgs
  ];

  // Add ffmpeg location if available
  if (fs.existsSync(FFMPEG_PATH)) {
    baseArgs.unshift('--ffmpeg-location', FFMPEG_PATH);
  }

  // Always add cookies file (guaranteed to be set by ensureCookiesInOptions)
  const resolvedCookiesFile = resolveCookiesFilePath(optionsWithCookies.cookiesFile!);
  if (fs.existsSync(resolvedCookiesFile)) {
    baseArgs.push('--cookies', resolvedCookiesFile);
    logger.info('✓ Successfully found and using cookies file', { cookiesFile: resolvedCookiesFile });
  } else {
    logger.warn('✗ Cookies file not found, proceeding without it', { 
      cookiesFile: optionsWithCookies.cookiesFile,
      resolvedPath: resolvedCookiesFile
    });
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
      // Log ALL yt-dlp stdout messages for enhanced debugging
      if (line.trim().length > 0) {
        logger.info('yt-dlp stdout', { line });
        console.log(`[yt-dlp stdout] ${line}`);
      }
    });

    ytdlpProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      stderrOutput += line + '\n';
      
      // Log all yt-dlp output regardless of content
      if (line.trim().length > 0) {
        logger.info('yt-dlp output', { 
          message: line,
          operation: 'video_download'
        });
        console.log(`[yt-dlp] ${line}`);
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

export async function getVideoMetadata(videoUrl: string, options: DownloadOptions = {}): Promise<VideoMetadata> {
  checkBinaries();
  
  // Ensure cookies are always included
  const optionsWithCookies = ensureCookiesInOptions(options);
  
  let args = [
    '--dump-json',
    '--no-warnings',
    '--plugin-dirs','./.config/yt-dlp/plugins/',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_PROVIDER_URL || 'http://bgutil-provider:4416'}`,
  ];

  // Add ffmpeg location if available
  if (fs.existsSync(FFMPEG_PATH)) {
    args.unshift('--ffmpeg-location', FFMPEG_PATH);
  }

  // Always add cookies file (guaranteed to be set by ensureCookiesInOptions)
  const resolvedCookiesFile = resolveCookiesFilePath(optionsWithCookies.cookiesFile!);
  if (fs.existsSync(resolvedCookiesFile)) {
    args.push('--cookies', resolvedCookiesFile);
    logger.info('✓ Successfully found and using cookies file for metadata', { cookiesFile: resolvedCookiesFile });
  } else {
    logger.warn('✗ Cookies file not found for metadata, proceeding without it', { 
      cookiesFile: optionsWithCookies.cookiesFile,
      resolvedPath: resolvedCookiesFile
    });
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

    // Log all stderr output regardless of content
    if (stderr) {
      const lines = stderr.trim().split('\n');
      lines.forEach(line => {
        if (line.trim().length > 0) {
          logger.info('yt-dlp metadata output', { 
            message: line.trim(),
            operation: 'metadata_fetch'
          });
          console.log(`[yt-dlp metadata] ${line.trim()}`);
        }
      });
    }
    
    try {
      const metadata = JSON.parse(stdout) as VideoMetadata;
      
      // Note: Video metadata is no longer uploaded to RDS, only episode data
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
                  
                  // Clean up empty directories after deleting the audio file
                  const audioDir = path.dirname(finalPath);
                  await cleanupEmptyDirectories(audioDir);
                } catch (deleteError) {
                  logger.warn('Failed to delete local audio file', { error: deleteError, filename: path.basename(finalPath) });
                }
              } else {
                logger.info('Keeping local audio file for further processing', { filename: path.basename(finalPath) });
              }
            } else {
              logger.error('Failed to upload podcast audio to S3', undefined, { error: uploadResult.error });
              
              // Clean up local file if upload failed and deleteLocalAfterUpload is true
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalPath);
                  logger.info('Deleted local audio file after failed S3 upload', { filename: path.basename(finalPath) });
                  
                  // Clean up empty directories after deleting the audio file
                  const audioDir = path.dirname(finalPath);
                  await cleanupEmptyDirectories(audioDir);
                } catch (deleteError) {
                  logger.warn('Failed to delete local audio file after failed upload', { error: deleteError, filename: path.basename(finalPath) });
                }
              }
            }
          } else {
            logger.warn('S3 service not available, skipping upload');
            
            // Clean up local file if S3 upload was requested but service is unavailable
            const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
            if (shouldDeleteLocal) {
              try {
                await cleanupFileAndDirectories(finalPath);
                logger.info('Deleted local audio file (S3 service unavailable)', { filename: path.basename(finalPath) });
              } catch (deleteError) {
                logger.warn('Failed to delete local audio file', { error: deleteError, filename: path.basename(finalPath) });
              }
            }
          }
        } catch (error: any) {
          logger.error('Error during S3 upload', error);
          
          // Clean up local file if S3 upload was requested but failed with error
          const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
          if (shouldDeleteLocal) {
            try {
              await cleanupFileAndDirectories(finalPath);
              logger.info('Deleted local audio file after S3 upload error', { filename: path.basename(finalPath) });
            } catch (deleteError) {
              logger.warn('Failed to delete local audio file after upload error', { error: deleteError, filename: path.basename(finalPath) });
            }
          }
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
export function downloadAndMergeVideo(
  channelId: string, 
  videoUrl: string, 
  options: DownloadOptions = {}, 
  metadata?: VideoMetadata,
  channelInfo?: SQSMessageBody
): Promise<{ mergedFilePath: string, episodePK:string, episodeSK:string}> {
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
      let episodePK = '';
      let episodeSK = '';
      let episodeGenreSK = '';
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
        
        // Process metadata and save podcast episode data to RDS when audio is finished
        // Use the new RDS service method that handles all the new schema fields
        try {
          const rdsService = createRDSServiceFromEnv();
          if (rdsService && videoMetadata && uploadedAudioInfo?.location) {
            logger.info('💾 Processing and saving podcast episode metadata to RDS...');
            
            // Use the RDS service to process and create episode from SQS message
            if (channelInfo) {
              // channelInfo is already in the new SQS message format - pass directly
              const savedEpisode = await rdsService.processEpisodeFromSQS(
                channelInfo,
                videoMetadata,
                uploadedAudioInfo.location,
                true, // Enable guest enrichment
                true  // Enable topic enrichment
              );
              
              if (savedEpisode) {
                episodePK = `EPISODE#${savedEpisode.episodeId}`; // For backward compatibility
                logger.info(`✅ Episode metadata saved successfully to RDS: ${savedEpisode.episodeId}`);
                
                // Log guest enrichment results if available
                const guestEnrichmentData = savedEpisode.additionalData?.guestEnrichment;
                if (guestEnrichmentData) {
                  logger.info(`🎯 Guest enrichment completed: ${guestEnrichmentData.successCount}/${guestEnrichmentData.totalCount} guests enriched`);
                }
              } else {
                logger.warn(`⚠️ Failed to save episode metadata to RDS`);
              }
            } else {
              // Fallback for cases without channel info - create minimal episode record
              const episodeId = generateEpisodeId();
              const episodeRecord = {
                episodeId: episodeId,
                episodeTitle: videoMetadata.title || 'Untitled',
                episodeDescription: videoMetadata.description || '',
                channelName: videoMetadata.uploader || 'Unknown Channel',
                publishedDate: parseVideoDate(videoMetadata.upload_date) || new Date(),
                episodeUri: uploadedAudioInfo.location,
                originalUri: videoMetadata.webpage_url || '',
                channelId: channelId,
                country: 'USA',
                durationMillis: videoMetadata.duration ? videoMetadata.duration * 1000 : 0,
                contentType: 'Audio' as const,
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
                  viewCount: videoMetadata.view_count || 0,
                  likeCount: videoMetadata.like_count || 0,
                  originalVideoId: videoMetadata.id || '',
                  extractor: videoMetadata.extractor || 'youtube'
                },
                processingDone: false,
                isSynced: false
              };

              const savedEpisode = await rdsService.createEpisode(episodeRecord);
              if (savedEpisode) {
                episodePK = `EPISODE#${episodeId}`;
                logger.info(`✅ Fallback episode metadata saved successfully to RDS: ${episodeId}`);
              } else {
                logger.warn(`⚠️ Failed to save fallback episode metadata to RDS: ${episodeId}`);
              }
            }
          } else {
            logger.warn('⚠️ RDS service not available, metadata missing, or audio upload failed - skipping episode metadata processing');
          }
        } catch (error: any) {
          logger.error(`❌ Error processing episode metadata: ${error.message}`);
        }
        
        return episodePK;
      });
      
      // Wait for video download
      tempVideoPath = await videoDownloadPromise;
      episodePK = await audioPromise;
      
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
        episodePK: episodePK,
        episodeSK: episodeSK,
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
              // Update RDS with video S3 URL
              try {
                const rdsService = createRDSServiceFromEnv();
                if (rdsService && episodePK) {
                  // Extract episodeId from PK format (EPISODE#episodeId)
                  const episodeId = episodePK.replace('EPISODE#', '');
                  logger.info('💾 Updating episode with video S3 URL...');
                  const updateSuccess = await rdsService.updateEpisode(episodeId, {
                    episodeUri: uploadResult.location, // Set S3 video URL
                    contentType: 'Video' // Update content type to Video
                  });
                  if (updateSuccess) {
                    logger.info(`✅ Episode ${episodeId} updated with video S3 URL`);
                  } else {
                    logger.warn(`⚠️ Failed to update episode ${episodeId} with video S3 URL`);
                  }
                }
              } catch (updateError: any) {
                logger.warn('⚠️ RDS video URL update error:', updateError.message);
              }
              
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalMergedPath);
                  logger.info(`🗑️ Deleted local video file after S3 upload: ${path.basename(finalMergedPath)}`);
                  
                  // Clean up empty directories after deleting the final video file
                  const videoDir = path.dirname(finalMergedPath);
                  await cleanupEmptyDirectories(videoDir);
                } catch (deleteError) {
                  logger.warn(`⚠️ Failed to delete local video file: ${deleteError}`);
                }
              } else {
                logger.info(`📁 Keeping local video file: ${path.basename(finalMergedPath)}`);
              }
            } else {
              logger.error(`❌ Failed to upload video to S3: ${uploadResult.error}`);
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalMergedPath);
                  logger.info(`🗑️ Deleted local video file after failed S3 upload: ${path.basename(finalMergedPath)}`);
                  
                  // Clean up empty directories after deleting the final video file
                  const videoDir = path.dirname(finalMergedPath);
                  await cleanupEmptyDirectories(videoDir);
                } catch (deleteError) {
                  logger.warn(`⚠️ Failed to delete local video file after failed upload: ${deleteError}`);
                }
              }
            }
          } else {
            logger.warn('⚠️ S3 service not available, skipping upload');
            const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
            if (shouldDeleteLocal) {
              try {
                await cleanupFileAndDirectories(finalMergedPath);
                logger.info(`🗑️ Deleted local video file (S3 service unavailable): ${path.basename(finalMergedPath)}`);
              } catch (deleteError) {
                logger.warn(`⚠️ Failed to delete local video file: ${deleteError}`);
              }
            }
          }
        } catch (error: any) {
          logger.error('❌ Error during S3 video upload:', error.message);
          // Clean up local file if S3 upload was requested but failed
          const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
          if (shouldDeleteLocal) {
            try {
              await cleanupFileAndDirectories(finalMergedPath);
              logger.info(`🗑️ Deleted local video file after S3 upload error: ${path.basename(finalMergedPath)}`);
            } catch (deleteError) {
              logger.warn(`⚠️ Failed to delete local video file after upload error: ${deleteError}`);
            }
          }
        }
      } else {
        // S3 upload not enabled - optionally clean up local files based on a separate flag
        // For now, we keep the file since S3 upload is disabled intentionally
        logger.info(`📁 S3 upload disabled, keeping local video file: ${path.basename(finalMergedPath)}`);
      }
      
      resolve(resultObj);

    } catch (error: any) {
      logger.error(`Error during download and merge process: ${error.message}`);
      
      // Clean up temp files on error
      try {
        if (tempVideoPath && fs.existsSync(tempVideoPath)) {
          await cleanupFileAndDirectories(tempVideoPath, tempDir);
          logger.info('🗑️ Cleaned up temporary video file after error');
        }
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
          await cleanupFileAndDirectories(tempAudioPath, tempDir);
          logger.info('🗑️ Cleaned up temporary audio file after error');
        }
        
        // Clean up final merged file if it was created but process failed later
        if (finalMergedPath && fs.existsSync(finalMergedPath)) {
          await cleanupFileAndDirectories(finalMergedPath);
          logger.info('🗑️ Cleaned up partial merged file after error');
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
        
        // Clean up final merged file directory if it exists
        if (finalMergedPath) {
          const finalVideoDir = path.dirname(finalMergedPath);
          await cleanupEmptyDirectories(finalVideoDir);
        }
        
        // Clean up the main temp directory if it's empty
        await cleanupEmptyDirectories(tempDir);
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
      if (output.trim().length > 0) {
        logger.info(`ffmpeg output`, { message: output });
        console.log(`[ffmpeg] ${output}`);
      }
    });

    ffmpegProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      ffmpegOutput += output + '\n';
      if (output.trim().length > 0) {
        logger.info(`ffmpeg stdout`, { message: output });
        console.log(`[ffmpeg stdout] ${output}`);
      }
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
    // Normalize paths to avoid issues with path comparison
    const normalizedDirPath = path.resolve(dirPath);
    const normalizedStopAtRoot = path.resolve(stopAtRoot);
    
    // Don't clean up if directory doesn't exist, is the root, or is above the root
    if (!fs.existsSync(normalizedDirPath) || 
        normalizedDirPath === normalizedStopAtRoot || 
        !normalizedDirPath.startsWith(normalizedStopAtRoot)) {
      return;
    }
    
    // Get directory contents
    const files = await fsPromises.readdir(normalizedDirPath);
    
    // If directory is empty, remove it
    if (files.length === 0) {
      await fsPromises.rmdir(normalizedDirPath);
      logger.info(`🗑️ Removed empty directory: ${path.basename(normalizedDirPath)}`);
      
      // Recursively clean up parent directory if it's now empty
      const parentDir = path.dirname(normalizedDirPath);
      if (parentDir !== normalizedStopAtRoot && parentDir !== normalizedDirPath) {
        await cleanupEmptyDirectories(parentDir, normalizedStopAtRoot);
      }
    } else {
      logger.debug(`Directory not empty, keeping: ${path.basename(normalizedDirPath)} (${files.length} items)`);
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.debug(`Directory already removed: ${dirPath}`);
    } else if (error.code === 'ENOTEMPTY') {
      logger.debug(`Directory not empty (race condition): ${dirPath}`);
    } else {
      logger.warn(`Failed to clean up directory ${dirPath}:`, error.message);
    }
  }
}

/**
 * Comprehensive cleanup helper that removes files and cleans up empty directories
 */
async function cleanupFileAndDirectories(filePath: string, stopAtRoot: string = DEFAULT_OUTPUT_DIR): Promise<void> {
  try {
    // First, delete the file if it exists
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
      logger.info(`🗑️ Deleted file: ${path.basename(filePath)}`);
    }
    
    // Then clean up empty directories
    const fileDir = path.dirname(filePath);
    await cleanupEmptyDirectories(fileDir, stopAtRoot);
  } catch (error: any) {
    logger.warn(`Failed to cleanup file and directories for ${filePath}:`, error.message);
  }
}

/**
 * Download video with audio (merged) without any database operations
 * This is specifically for existing episodes where we just need the video file
 * 
 * @param videoUrl - The YouTube video URL to download
 * @param options - Download options including S3 upload configuration
 * @param metadata - Optional video metadata to use for naming
 * @returns Promise<string> - Returns S3 key if upload is successful, otherwise local file path
 */
export async function downloadVideoWithAudioSimple(videoUrl: string, options: DownloadOptions = {}, metadata?: VideoMetadata): Promise<string> {
  checkBinaries();
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  let outputFilenameTemplate = options.outputFilename || 'video-with-audio.%(ext)s';
  
  // Use best video+audio format (merged)
  const format = options.format || 'best[ext=mp4]/best';

  // Prepare output template with metadata if available
  if (metadata) {
    outputFilenameTemplate = prepareOutputTemplate(outputFilenameTemplate, metadata, true); // Use subdirectory for final files
  }
  
  // Ensure the directory structure exists
  const templatePath = path.join(outputDir, outputFilenameTemplate);
  const templateDir = path.dirname(templatePath);
  if (!fs.existsSync(templateDir)) {
    fs.mkdirSync(templateDir, { recursive: true });
  }
  
  const outputPathAndFilename = templatePath;

  // Build args for video+audio download (no additional flags needed, yt-dlp will merge automatically)
  const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options);

  logger.info(`Starting video+audio download for: ${videoUrl}`);
  const downloadedPath = await executeDownloadProcess(baseArgs, options);
  
  // Upload to S3 if enabled
  if (options.s3Upload?.enabled) {
    try {
      const s3Service = createS3ServiceFromEnv();
      if (s3Service) {
        logger.info('Uploading video to S3');
        
        // Use provided metadata or fallback to fetching it
        let videoMetadata = metadata;
        if (!videoMetadata) {
          try {
            videoMetadata = await getVideoMetadata(videoUrl);
          } catch (metaError) {
            logger.warn('Could not fetch metadata for S3 naming, using fallback', { error: metaError });
          }
        }
        
        // Generate S3 key for video
        let videoKey: string;
        if (videoMetadata) {
          const videoExtension = path.extname(downloadedPath).substring(1) || 'mp4';
          videoKey = generateVideoS3Key(videoMetadata, videoExtension);
        } else {
          // Fallback naming
          const filename = path.basename(downloadedPath);
          videoKey = `videos/${filename}`;
        }
        
        const bucketName = getVideoBucketName();
        const uploadResult = await s3Service.uploadFile(downloadedPath, bucketName, videoKey);
        
        if (uploadResult.success) {
          logger.info('Video uploaded to S3 successfully', { location: uploadResult.location, videoKey });
          
          // Only delete local file if deleteLocalAfterUpload is not explicitly set to false
          const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
          if (shouldDeleteLocal) {
            try {
              await s3Service.deleteLocalFile(downloadedPath);
              logger.info('Deleted local video file after S3 upload', { filename: path.basename(downloadedPath) });
              
              // Clean up empty directories after deleting the video file
              const videoDir = path.dirname(downloadedPath);
              await cleanupEmptyDirectories(videoDir);
            } catch (deleteError) {
              logger.warn('Failed to delete local video file', { error: deleteError, filename: path.basename(downloadedPath) });
            }
          } else {
            logger.info('Keeping local video file for further processing', { filename: path.basename(downloadedPath) });
          }
          
          // Return S3 key when upload is successful
          return videoKey;
        } else {
          logger.error('Failed to upload video to S3', undefined, { error: uploadResult.error });
          
          // Clean up local file if upload failed and deleteLocalAfterUpload is true
          const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
          if (shouldDeleteLocal) {
            try {
              await s3Service.deleteLocalFile(downloadedPath);
              logger.info('Deleted local video file after failed S3 upload', { filename: path.basename(downloadedPath) });
              
              // Clean up empty directories after deleting the video file
              const videoDir = path.dirname(downloadedPath);
              await cleanupEmptyDirectories(videoDir);
            } catch (deleteError) {
              logger.warn('Failed to delete local video file after failed upload', { error: deleteError, filename: path.basename(downloadedPath) });
            }
          }
        }
      } else {
        logger.warn('S3 service not available, skipping upload');
        
        // Clean up local file if S3 upload was requested but service is unavailable
        const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
        if (shouldDeleteLocal) {
          try {
            await cleanupFileAndDirectories(downloadedPath);
            logger.info('Deleted local video file (S3 service unavailable)', { filename: path.basename(downloadedPath) });
          } catch (deleteError) {
            logger.warn('Failed to delete local video file', { error: deleteError, filename: path.basename(downloadedPath) });
          }
        }
      }
    } catch (error: any) {
      logger.error('Error during S3 upload', error);
      
      // Clean up local file if S3 upload was requested but failed with error
      const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
      if (shouldDeleteLocal) {
        try {
          await cleanupFileAndDirectories(downloadedPath);
          logger.info('Deleted local video file after S3 upload error', { filename: path.basename(downloadedPath) });
        } catch (deleteError) {
          logger.warn('Failed to delete local video file after upload error', { error: deleteError, filename: path.basename(downloadedPath) });
        }
      }
    }
  }
  
  // Return local path if S3 upload is disabled or failed
  return downloadedPath;
}

/**
 * Create RDS service with credentials from environment variables
 */
function createRDSServiceFromEnv(): RDSService | null {
  try {
    const rdsConfig = {
      host: process.env.RDS_HOST || 'localhost',
      user: process.env.RDS_USER || 'postgres',
      password: process.env.RDS_PASSWORD || '',
      database: process.env.RDS_DATABASE || 'postgres',
      port: parseInt(process.env.RDS_PORT || '5432'),
      ssl: process.env.RDS_SSL_ENABLED === 'true' ? { rejectUnauthorized: false } : false,
    };

    return new RDSService(rdsConfig);
  } catch (error: any) {
    logger.error('❌ Failed to create RDS service from environment:', error.message);
    return null;
  }
}

/**
 * Manually enrich guests for existing episodes by episode ID
 */
export async function enrichExistingEpisodeGuests(episodeId: string): Promise<EpisodeRecord | null> {
  logger.info(`🔍 Starting manual guest enrichment for episode: ${episodeId}`);
  
  try {
    const rdsService = createRDSServiceFromEnv();
    if (!rdsService) {
      logger.error('❌ RDS service not available for guest enrichment');
      return null;
    }

    const enrichedEpisode = await rdsService.enrichGuestInfo(episodeId);
    
    if (enrichedEpisode) {
      logger.info(`✅ Successfully enriched guests for episode: ${episodeId}`);
      return enrichedEpisode;
    } else {
      logger.warn(`⚠️ Failed to enrich guests for episode: ${episodeId}`);
      return null;
    }
  } catch (error: any) {
    logger.error(`❌ Error during manual guest enrichment for episode ${episodeId}:`, error);
    return null;
  }
}

/**
 * Batch enrich guests for multiple episodes
 */
export async function batchEnrichEpisodeGuests(episodeIds: string[]): Promise<{
  successful: string[];
  failed: string[];
}> {
  logger.info(`🔍 Starting batch guest enrichment for ${episodeIds.length} episodes`);
  
  const results = {
    successful: [] as string[],
    failed: [] as string[]
  };

  for (const episodeId of episodeIds) {
    try {
      const enrichedEpisode = await enrichExistingEpisodeGuests(episodeId);
      
      if (enrichedEpisode) {
        results.successful.push(episodeId);
      } else {
        results.failed.push(episodeId);
      }
      
      // Add delay between batch operations to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      logger.error(`❌ Batch enrichment error for episode ${episodeId}:`, error);
      results.failed.push(episodeId);
    }
  }

  logger.info(`✅ Batch guest enrichment completed: ${results.successful.length} successful, ${results.failed.length} failed`);
  return results;
}

/**
 * Manually enrich topics for existing episodes by episode ID
 */
export async function enrichExistingEpisodeTopics(episodeId: string): Promise<EpisodeRecord | null> {
  logger.info(`🔍 Starting manual topic enrichment for episode: ${episodeId}`);
  
  try {
    const rdsService = createRDSServiceFromEnv();
    if (!rdsService) {
      logger.error('❌ RDS service not available for topic enrichment');
      return null;
    }

    const enrichedEpisode = await rdsService.enrichTopicInfo(episodeId);
    
    if (enrichedEpisode) {
      logger.info(`✅ Successfully enriched topics for episode: ${episodeId}`);
      return enrichedEpisode;
    } else {
      logger.warn(`⚠️ Failed to enrich topics for episode: ${episodeId}`);
      return null;
    }
  } catch (error: any) {
    logger.error(`❌ Error during manual topic enrichment for episode ${episodeId}:`, error);
    return null;
  }
}

/**
 * Batch enrich topics for multiple episodes
 */
export async function batchEnrichEpisodeTopics(episodeIds: string[]): Promise<{
  successful: string[];
  failed: string[];
}> {
  logger.info(`🔍 Starting batch topic enrichment for ${episodeIds.length} episodes`);
  
  const results = {
    successful: [] as string[],
    failed: [] as string[]
  };

  for (const episodeId of episodeIds) {
    try {
      const enrichedEpisode = await enrichExistingEpisodeTopics(episodeId);
      
      if (enrichedEpisode) {
        results.successful.push(episodeId);
      } else {
        results.failed.push(episodeId);
      }
      
      // Add delay between batch operations to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      logger.error(`❌ Batch topic enrichment error for episode ${episodeId}:`, error);
      results.failed.push(episodeId);
    }
  }

  logger.info(`✅ Batch topic enrichment completed: ${results.successful.length} successful, ${results.failed.length} failed`);
  return results;
}

/**
 * Batch enrich both guests and topics for multiple episodes
 */
export async function batchEnrichEpisodeComplete(episodeIds: string[]): Promise<{
  successful: string[];
  failed: string[];
}> {
  logger.info(`🔍 Starting batch complete enrichment (guests + topics) for ${episodeIds.length} episodes`);
  
  const results = {
    successful: [] as string[],
    failed: [] as string[]
  };

  for (const episodeId of episodeIds) {
    try {
      const rdsService = createRDSServiceFromEnv();
      if (!rdsService) {
        logger.error('❌ RDS service not available for complete enrichment');
        results.failed.push(episodeId);
        continue;
      }

      const enrichedEpisode = await rdsService.enrichEpisodeInfo(episodeId, {
        enrichGuests: true,
        enrichTopics: true
      });
      
      if (enrichedEpisode) {
        results.successful.push(episodeId);
      } else {
        results.failed.push(episodeId);
      }
      
      // Add delay between batch operations to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1500)); // Longer delay for complete enrichment
    } catch (error: any) {
      logger.error(`❌ Batch complete enrichment error for episode ${episodeId}:`, error);
      results.failed.push(episodeId);
    }
  }

  logger.info(`✅ Batch complete enrichment completed: ${results.successful.length} successful, ${results.failed.length} failed`);
  return results;
}
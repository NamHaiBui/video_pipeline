import { execFile, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { VideoMetadata, ProgressInfo, DownloadOptions, CommandResult, SQSJobMessage } from '../types.js';
import { S3Service, S3UploadResult, createS3ServiceFromEnv } from './s3Service.js';
import { RDSService, SQSMessageBody, EpisodeRecord, createRDSServiceFromEnv } from './rdsService.js';
import { GuestExtractionResult } from './guestExtractionService.js';
import { isValidYouTubeUrl } from './utils/urlUtils.js';
import { generateAudioS3Key, generateLowerDefVideoS3Key, generateM3U8S3Key, generateThumbnailS3Key, generateVideoS3Key, getPublicUrl, getS3ArtifactBucket } from './s3KeyUtils.js';
import { sanitizeFilename, sanitizeOutputTemplate, create_slug, getManifestUrl, getThumbnailUrl } from './utils/utils.js';
import { logger } from './utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { withSemaphore, diskSemaphore, httpSemaphore, computeDefaultConcurrency } from './utils/concurrency.js';
import { ValidationService } from './validationService.js';
import { sendToTranscriptionQueue } from '../sqsPoller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
type VideoQuality = '1080p' | '720p' | '480p' | '360p';
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
function ensureCookiesInOptions(options: DownloadOptions): DownloadOptions {
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
 * Get optimal audio format for podcast content - always returns MP3
 */
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
  options: DownloadOptions,
  additionalArgs: string[] = []
): string[] {
  // Ensure cookies are always included
  const optionsWithCookies = ensureCookiesInOptions(options);
  // Make yt-dlp connections CPU-aware: use all available CPU cores for maximum throughput
  const maxCpuConnections = computeDefaultConcurrency('cpu');
  const ytdlpConnections = Math.max(1, parseInt(process.env.YTDLP_CONNECTIONS || '', 4) || maxCpuConnections);
  if (process.env.LOG_LEVEL !== 'silent') {
    logger.info('yt-dlp connection tuning', { ytdlpConnections, maxCpuConnections });
  }
  
  let baseArgs = [
    videoUrl,
    '-o', outputPathAndFilename,
    '-f', format,
    '--plugin-dirs','./.config/yt-dlp/plugins/',
    '-N', String(ytdlpConnections),
  '--no-part',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_PROVIDER_URL || 'http://localhost:4416'}`,
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
  return withSemaphore(diskSemaphore, 'disk_ytdlp', () => new Promise((resolve, reject) => {
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
    });

    ytdlpProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      stderrOutput += line + '\n';
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
  }));
}

export async function getVideoMetadata(videoUrl: string, options: DownloadOptions = {}): Promise<VideoMetadata> {
  checkBinaries();
  const optionsWithCookies = ensureCookiesInOptions(options);
  
  let args = [
    '--dump-json',
    '--no-warnings',
    '--plugin-dirs','./.config/yt-dlp/plugins/',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_PROVIDER_URL || 'http://localhost:4416'}`,
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

  // Intentionally silence yt-dlp metadata stderr noise
    
    try {
      const metadata = JSON.parse(stdout) as VideoMetadata;
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

export function downloadPodcastAudioWithProgress(videoUrl: string, options: DownloadOptions, metadata?: VideoMetadata): Promise<string> {
  checkBinaries();
  return new Promise(async (resolve, reject) => {
    const outputDir = options.outputDir || PODCAST_OUTPUT_DIR;
    let outputFilenameTemplate = options.outputFilename || 'unknown-podcast/untitled-episode.%(ext)s';
    const format = getPodcastAudioFormat();
    
    // Use provided metadata or fetch it once
    let videoMetadata = metadata;
    if (!videoMetadata) {
      try {
        videoMetadata = await getVideoMetadata(videoUrl, options);
      } catch (metaError) {
        logger.warn('Could not fetch metadata for filename optimization, using template as-is', { error: metaError });
      }
    }
    
    // Prepare output template with metadata only if caller did not specify an explicit filename
    if (!options.outputFilename && videoMetadata) {
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
            
            const bucketName = getS3ArtifactBucket();
            const uploadResult = await s3Service.uploadFile(finalPath, bucketName, audioKey);
            
            if (uploadResult.success) {
              logger.info('Podcast audio uploaded to S3 successfully', { location: uploadResult.location });
              
              // Only delete local file if deleteLocalAfterUpload is not explicitly set to false
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalPath);
                  logger.info('Deleted local audio file after S3 upload', { filename: path.basename(finalPath) });
                  
                  // Clean up empty directories after deleting the audio file - use podcast cleanup
                  const audioDir = path.dirname(finalPath);
                  await cleanupEmptyPodcastDirectories(audioDir);
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
                  
                  // Clean up empty directories after deleting the audio file - use podcast cleanup
                  const audioDir = path.dirname(finalPath);
                  await cleanupEmptyPodcastDirectories(audioDir);
                } catch (deleteError) {
                  logger.warn('Failed to delete local audio file after failed upload', { error: deleteError, filename: path.basename(finalPath) });
                }
              }
            }
          } else {
            logger.warn('S3 service not available, skipping upload');
            const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
            if (shouldDeleteLocal) {
              try {
                await cleanupPodcastFileAndDirectories(finalPath);
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
              await cleanupPodcastFileAndDirectories(finalPath);
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
export function downloadVideoNoAudioWithProgress(videoUrl: string, options: DownloadOptions, videoDefinition:string, metadata?: VideoMetadata, ): Promise<string> {
    checkBinaries();

    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    let outputFilenameTemplate = options.outputFilename || 'unknown-podcast/untitled-episode.%(ext)s';
    
    // More flexible format selection for video-only downloads
    const format = options.format || `bestvideo[height<=${videoDefinition}]/bestvideo[height<=${parseInt(videoDefinition)+200}]/bestvideo/best[height<=${videoDefinition}]/best`;

    // Prepare output template with metadata only if caller did not specify an explicit filename
    if (!options.outputFilename && metadata) {
      outputFilenameTemplate = prepareOutputTemplate(outputFilenameTemplate, metadata, false); 
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
 * Download video and audio separately, then merge them into a single file
 */
export function downloadAndMergeVideo(
  channelId: string, 
  videoUrl: string, 
  options: DownloadOptions,
  metadata?: VideoMetadata,
  channelInfo?: SQSMessageBody,
  guestExtractionResult?: GuestExtractionResult
): Promise<{ mergedFilePath: string, episodeId:string}> {
  checkBinaries();
  return new Promise(async (resolve, reject) => {
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    let outputFilenameTemplate = options.outputFilename;
    if (outputFilenameTemplate === undefined || outputFilenameTemplate === null) {
      return reject(new Error('Output filename template is required for video download'));
    }
    // Use provided metadata or fetch it once
    let videoMetadata = metadata;
    if (!videoMetadata) {
      try {
        videoMetadata = await getVideoMetadata(videoUrl, options);
      } catch (metaError) {
        const errorMsg = typeof metaError === 'object' && metaError !== null && 'message' in metaError ? (metaError as { message?: string }).message : String(metaError);
        return reject(new Error(`Could not fetch metadata for video URL: ${videoUrl}. Error: ${errorMsg}`));
      }
    }
    
    // Prepare output template with metadata if available
    if (!options.outputFilename && videoMetadata) {
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
    let episodeId = '';
    try {
      logger.info(`Starting video+audio download and merge for: ${videoUrl}`);
      logger.info('Starting parallel download of video and audio streams...');
      
      // Create slug-based temporary filenames
      const podcastSlug = videoMetadata ? create_slug(videoMetadata.uploader || 'unknown') : 'unknown-podcast';
      const episodeSlug = videoMetadata ? create_slug(videoMetadata.title || 'untitled') : 'untitled-episode';
      // const m3u8PlayList = await downloadContent(getManifestUrl(videoMetadata));
      const thumbnail = await downloadContent(getThumbnailUrl(videoMetadata));
      
      const timestamp = Date.now();
      const videoDefinition = metadata?.filesize_approx && metadata.filesize_approx < 1000000 ? '1080' : '720';
      
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
      }, videoDefinition, videoMetadata);

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
      let thumbnail_s3_link = '';
      const audioPromise = audioDownloadPromise.then(async (audioPath: string) => {
        tempAudioPath = audioPath;
        logger.info(`Audio download completed successfully: ${audioPath}`);
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            const thumbnail_s3_key = generateThumbnailS3Key(videoMetadata);
            logger.info('Uploading thumbnail to S3...');
            try {
              thumbnail_s3_link = await s3Service.uploadThumbnailToS3(thumbnail!, getS3ArtifactBucket(), thumbnail_s3_key)
                .then(res => res?.location || '');
            } catch (err: any) {
              logger.error('Error uploading thumbnail to S3:', err.message || err);
              thumbnail_s3_link = '';
            }
            const audios3Key = generateAudioS3Key(videoMetadata);
            logger.info('Uploading audio to S3...');
            uploadedAudioInfo = await s3Service.uploadFile(audioPath, getS3ArtifactBucket(), audios3Key);
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
        let updatedGuestInfo = false;
        let shouldSendToTranscriptionQueue = true; // Flag to control SQS message distribution
        
        // Process metadata and save podcast episode data to RDS when audio is finished
        // Use the new RDS service method that handles all the new schema fields
        try {
          const rdsService = createRDSServiceFromEnv();
          if (rdsService) {
            await rdsService.initClient();
          }
          
          // Fail if RDS service, metadata, or audio upload is not available
          if (!rdsService) {
            throw new Error('RDS service not available - cannot proceed without database connection');
          }
          if (!videoMetadata) {
            throw new Error('Video metadata is required - cannot proceed without metadata');
          }
          if (!uploadedAudioInfo?.location) {
            throw new Error('Audio upload failed - cannot proceed without uploaded audio');
          }
          
          // Fail if channelInfo (SQS message) is not provided
          if (!channelInfo) {
            throw new Error('SQS message (channelInfo) is required - cannot proceed without proper message data');
          }
          
          logger.info('💾 Processing and saving podcast episode metadata to RDS...');
          
          // Check processing status using multiple methods
          let processingStatus: any = null;
          let existingEpisode: any = null;
          
          // First check by youtubeVideoId if available
          if (videoMetadata.id) {
            existingEpisode = await rdsService.checkEpisodeExistsByYoutubeVideoId(videoMetadata.id);
            if (existingEpisode) {
              logger.info(`📝 Found existing episode by youtubeVideoId: ${existingEpisode.episodeId}`);
              
              // Check the processing status of the existing episode
              const additionalData = existingEpisode.additionalData || {};
              const hasVideoLocation = additionalData.videoLocation !== undefined;
              const hasMasterM3u8 = additionalData.master_m3u8 !== undefined;
              
              if (hasVideoLocation && hasMasterM3u8) {
                logger.info(`✅ Episode ${existingEpisode.episodeId} already fully processed - skipping all processing`);
                episodeId = existingEpisode.episodeId;
                shouldSendToTranscriptionQueue = false;
                
                // Update episode with guest extraction results if available, then return early
                if (guestExtractionResult) {
                  logger.info(`🎯 Updating existing fully-processed episode with guest extraction results...`);
                  await rdsService.updateEpisodeWithGuestExtraction(episodeId, guestExtractionResult);
                  logger.info(`✅ Guest extraction results updated for existing episode: ${episodeId}`);
                }
                
                // Return early - skip all video processing
                return episodeId;
              } else if (hasVideoLocation && !hasMasterM3u8) {
                logger.info(`🔄 Episode ${existingEpisode.episodeId} has videoLocation but missing master_m3u8 - will reprocess video`);
                episodeId = existingEpisode.episodeId;
                shouldSendToTranscriptionQueue = false; // Don't send transcription message for reprocessing
                
                // Update episode with guest extraction results if available
                if (guestExtractionResult) {
                  logger.info(`🎯 Updating existing episode with guest extraction results before reprocessing...`);
                  await rdsService.updateEpisodeWithGuestExtraction(episodeId, guestExtractionResult);
                  logger.info(`✅ Guest extraction results updated for existing episode: ${episodeId}`);
                  updatedGuestInfo = true;
                }
                
                // Continue with video processing but use existing episodeId
                logger.info(`🔄 Continuing with video processing for existing episode: ${episodeId}`);
              } else {
                logger.info(`📝 Episode ${existingEpisode.episodeId} exists but no videoLocation - will process normally`);
                episodeId = existingEpisode.episodeId;
                shouldSendToTranscriptionQueue = false; // Don't send SQS message for existing episodes
                
                // Update episode with guest extraction results if available
                if (guestExtractionResult) {
                  logger.info(`🎯 Updating existing episode with guest extraction results...`);
                  await rdsService.updateEpisodeWithGuestExtraction(episodeId, guestExtractionResult);
                  logger.info(`✅ Guest extraction results updated for existing episode: ${episodeId}`);
                  updatedGuestInfo = true;
                }
              }
            }
          }
          // If no existing episode found at all, create new one
          if (!existingEpisode && !processingStatus?.exists) {
            logger.info(`🆕 No existing episode found, creating new episode`);
            
            try {
              ({ episodeId } = await rdsService.storeNewEpisode(
                channelInfo,
                uploadedAudioInfo.location!,
                videoMetadata,
                thumbnail_s3_link
              ));

              logger.info(`✅ Episode metadata saved successfully to RDS: ${episodeId}`);

              // Update episode with guest extraction results if available
              if (guestExtractionResult) {
                logger.info(`🎯 Updating episode with guest extraction results...`);
                await rdsService.updateEpisodeWithGuestExtraction(episodeId, guestExtractionResult);
                logger.info(`✅ Guest extraction results updated for episode: ${episodeId}`);
                logger.info(`🎯 Found ${guestExtractionResult.guest_names.length} guests and ${guestExtractionResult.topics.length} topics`);
                updatedGuestInfo = true;
              }
            } catch (storeError: any) {
              if (storeError.message.includes('Duplicate episode detected')) {
                logger.warn(`⚠️ ${storeError.message}`);
                logger.warn(`🗑️ Skipping duplicate episode and cleaning up resources...`);
                
                // Since this is a duplicate, we should indicate to the caller that processing should stop
                throw new Error(`DUPLICATE_EPISODE: ${storeError.message}`);
              } else {
                throw storeError;
              }
            }
          }
          
          logger.info(`Episode processed with ID: ${episodeId}, Guest info updated: ${updatedGuestInfo}, Will send to transcription queue: ${shouldSendToTranscriptionQueue}`);
          
          if (!episodeId || episodeId.length === 0) {
            throw new Error('Episode ID is empty - cannot proceed without valid episode ID');
          }
          
          // Send message to transcription queue only if this is a new episode
          if (shouldSendToTranscriptionQueue) {
            logger.info('Preparing to send message to transcription queue...', {
              episodeId,
              uploadedAudioInfoAvailable: !!uploadedAudioInfo,
              audioLocation: uploadedAudioInfo?.location || 'undefined'
            });
            
            // Validate required fields before creating message
            if (!episodeId || episodeId.trim() === '') {
              logger.error('❌ Cannot send to transcription queue: episodeId is empty', undefined, { episodeId });
              throw new Error('Episode ID is required for transcription queue');
            }
            
            if (!uploadedAudioInfo?.location || uploadedAudioInfo.location.trim() === '') {
              logger.error('❌ Cannot send to transcription queue: audio location is empty', undefined, { 
                uploadedAudioInfo,
                location: uploadedAudioInfo?.location 
              });
              throw new Error('Audio location is required for transcription queue');
            }
            
            const transcribeSQSMessage = { 
              episodeId: episodeId.trim(), 
              audioUri: uploadedAudioInfo.location.trim() 
            };
            
            logger.info('Transcription message constructed:', {
              episodeId: transcribeSQSMessage.episodeId,
              audioUri: transcribeSQSMessage.audioUri,
              messageJSON: JSON.stringify(transcribeSQSMessage),
              messageLength: JSON.stringify(transcribeSQSMessage).length
            });
            
            await sendToTranscriptionQueue(transcribeSQSMessage);
            logger.info('✅ Message sent to transcription queue successfully');
          } else {
            logger.info('📭 Skipping transcription queue message for existing episode');
          }

        } catch (error: any) {
          logger.error(`❌ Error processing episode metadata: ${error.message}`);
          throw error; // Re-throw to fail the process
        }
        
        return episodeId;
      });
      
      tempVideoPath = await videoDownloadPromise;
      episodeId = await audioPromise;
      
      logger.info('Both downloads processed successfully!');
      logger.info(`Video: ${tempVideoPath}`);
      logger.info(`Audio: ${tempAudioPath}`);
      logger.info(`Episode ID: ${episodeId}`);
      // Store the audio path and upload info for later use

      // Generate final merged file path using slug-based naming
      if (videoMetadata) {
        const podcastSlug = create_slug(videoMetadata.uploader || 'unknown');
        const episodeSlug = create_slug(videoMetadata.title || 'untitled');
        
        // Create the podcast directory if it doesn't exist
        const podcastDir = path.join(outputDir, podcastSlug, episodeSlug);
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

      // Verify the merge was successful before cleaning up temp files
      if (!fs.existsSync(finalMergedPath)) {
        throw new Error(`Merged file was not created at expected location: ${finalMergedPath}`);
      }

      const mergedStats = fs.statSync(finalMergedPath);
      if (mergedStats.size === 0) {
        throw new Error(`Merged file is empty: ${finalMergedPath}`);
      }

      logger.info(`✅ Merge validation successful - file exists and has size: ${(mergedStats.size / 1024 / 1024).toFixed(2)} MB`);

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


      
      
      logger.info(`Video download and merge completed successfully: ${finalMergedPath}`);

      // Run HLS (lower renditions) unconditionally after merge. Upload to S3 only if available.
      let hlsMasterLink: string = '';
      try {
        const originalQuality: 1080 | 720 = videoDefinition === '1080' ? 1080 : 720;
        const hlsS3 = createS3ServiceFromEnv();
        const hlsBucket = hlsS3 ? getS3ArtifactBucket() : undefined;
        logger.info('🎬 Rendering HLS renditions after merge (unconditional)...');
        const metaForHls = videoMetadata || await getVideoMetadata(videoUrl);
        const renditionResult = await withRetry(
          () => renderingLowerDefinitionVersions(finalMergedPath, metaForHls, originalQuality, hlsS3, hlsBucket),
          3,
          2000,
          2
        );
        hlsMasterLink = renditionResult.masterPlaylists3Link || '';
        if (hlsMasterLink) {
          logger.info('✅ HLS renditions ready' , { master: hlsMasterLink });
        } else {
          logger.info('✅ HLS renditions generated locally (no S3 upload)');
        }
      } catch (renditionError: any) {
        logger.error('❌ HLS rendering failed (continuing):', renditionError?.message || renditionError);
      }

      if (options.s3Upload?.enabled) {
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            logger.info('🚀 Uploading merged video file to S3...');
            
            // Use already retrieved metadata instead of making another network call
            let videoKey: string| undefined;
            // let m3u8Key: string| undefined;
            if (videoMetadata) {
              const videoExtension = path.extname(finalMergedPath);
              videoKey = generateVideoS3Key(videoMetadata, videoExtension, videoDefinition);
            } 

            //Epic Fail condition to catch undefined keys to make me looks like an entry level dev
            if (videoKey === undefined || videoKey === null) {
              return reject(new Error('Failed to generate S3 key for video upload'));
            }
            const bucketName = getS3ArtifactBucket();
            const videoUploadResult = await s3Service.uploadFile(finalMergedPath, bucketName, videoKey);

            
            if (videoUploadResult.success) {
              logger.info(`Merged video uploaded. HLS renditions were already rendered; proceeding with metadata updates...`);
              
              // try {
                  // Ensure only '1080p' or '720p' is passed as originalQuality
                
              // } catch (renditionError) {
              //     logger.error(`❌ Failed to create and upload lower definition video renditions. This will not stop the main process.`, renditionError instanceof Error ? renditionError : new Error(String(renditionError)));
              // }
                try {
                const rdsService = createRDSServiceFromEnv();
                if (rdsService) {
                  logger.info('💾 Updating episode with video S3 URL in additionalData...');
                  await rdsService.updateEpisode(episodeId, {
                      additionalData: {
                        videoLocation: videoUploadResult.location
                      },
                      contentType: 'video'
                    });
                    const originalQuality: 1080 | 720 = videoDefinition === '1080' ? 1080 : 720;
                  // Also add master_m3u8 if available from earlier HLS run
                  logger.info(`✅ Episode ${episodeId} updated with video S3 URL in additionalData`);
                  if (hlsMasterLink) {
                    await rdsService.updateEpisode(episodeId, {
                      processingDone: true,
                      additionalData: {
                        master_m3u8: hlsMasterLink
                      },
                    });
                  }

                  // Independent validation: RDS + S3 existence checks
                  try {
                    const validation = new ValidationService(createS3ServiceFromEnv(), rdsService);
                    const expectAdditionalData = hlsMasterLink ? ['videoLocation', 'master_m3u8'] : ['videoLocation'];
                    const result = await validation.validateAfterProcessing({
                      episodeId,
                      expectAdditionalData,
                      s3Urls: [videoUploadResult.location, hlsMasterLink].filter(Boolean) as string[],
                    });
                    if (!result.ok) {
                      logger.error('❌ Post-process validation failed', new Error('validation_failed'), { errors: result.errors });
                    } else {
                      logger.info('✅ Post-process validation succeeded for episode', { episodeId });
                    }
                  } catch (vErr: any) {
                    logger.warn('Validation error (non-fatal):', vErr?.message || vErr);
                  }
                  }
                } catch (updateError: any) {
                  logger.warn('⚠️ RDS video URL update error:', updateError);
                }
               
              logger.info(`✅ Merged video uploaded to S3 successfully`, { location: videoUploadResult.location });
              const shouldDeleteLocal = true;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalMergedPath);
                  logger.info(`🗑️ Deleted local video file after S3 upload: ${path.basename(finalMergedPath)}`);
                  
                  const videoDir = path.dirname(finalMergedPath);
                  await cleanupEmptyPodcastDirectories(videoDir);
                } catch (deleteError) {
                  logger.warn(`⚠️ Failed to delete local video file: ${deleteError}`);
                }
              } else {
                logger.info(`📁 Keeping local video file: ${path.basename(finalMergedPath)}`);
              }
            } else {
              logger.error(`❌ Failed to upload video to S3`);
              const shouldDeleteLocal = options.s3Upload?.deleteLocalAfterUpload !== false;
              if (shouldDeleteLocal) {
                try {
                  await s3Service.deleteLocalFile(finalMergedPath);
                  logger.info(`🗑️ Deleted local video file after failed S3 upload: ${path.basename(finalMergedPath)}`);
                  const videoDir = path.dirname(finalMergedPath);
                  await cleanupEmptyPodcastDirectories(videoDir);
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
                await cleanupPodcastFileAndDirectories(finalMergedPath);
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
              await cleanupPodcastFileAndDirectories(finalMergedPath);
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

      resolve({ mergedFilePath: finalMergedPath, episodeId });

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
          await cleanupPodcastFileAndDirectories(finalMergedPath);
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
          await cleanupEmptyPodcastDirectories(finalVideoDir);
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
export function mergeVideoAudioWithValidation(videoPath: string, audioPath: string, outputPath: string, _options: DownloadOptions): Promise<string> {
  checkBinaries();
  
  return withSemaphore(diskSemaphore, 'disk_ffmpeg_merge', () => new Promise((resolve, reject) => {
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

    // Ensure output directory exists and is writable
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      logger.info(`Creating output directory: ${outputDir}`);
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Test write access to output directory
    try {
      const testFile = path.join(outputDir, '.write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      logger.info(`✅ Write access confirmed to: ${outputDir}`);
    } catch (writeError) {
      logger.error(`❌ No write access to output directory: ${outputDir}`);
      return reject(new Error(`Cannot write to output directory: ${outputDir}`));
    }

    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-y',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
  // Note: no '-threads' here since we're stream-copying; avoids FFmpeg warning about unused option
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

    ffmpegProcess.on('close', async (code: number | null) => {
      if (code === 0) {
        // Give filesystem time to sync after merge
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Post-merge validation with detailed logging
        if (!fs.existsSync(outputPath)) {
          logger.error(`❌ Merged file was not created: ${outputPath}`);
          
          // Debug output directory contents
          const outputDir = path.dirname(outputPath);
          if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir);
            logger.error(`Files in output directory ${outputDir}:`, undefined, { directory: outputDir, files });
          } else {
            logger.error(`Output directory does not exist: ${outputDir}`);
          }
          
          return reject(new Error(`Merged file was not created: ${outputPath}`));
        }

        const mergedStats = fs.statSync(outputPath);
        if (mergedStats.size === 0) {
          logger.error(`❌ Merged file is empty: ${outputPath}`);
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
  }));
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
 * Clean up empty directories for podcast episodes - goes one level above podcast title
 * This allows cleanup of the podcast-title directory if all episodes are removed
 */
async function cleanupEmptyPodcastDirectories(dirPath: string): Promise<void> {
  try {
    // For podcast cleanup, we want to go one level above the DEFAULT_OUTPUT_DIR
    // so that if a podcast-title directory becomes empty, it gets cleaned up
    const podcastStopAtRoot = path.dirname(DEFAULT_OUTPUT_DIR);
    await cleanupEmptyDirectories(dirPath, podcastStopAtRoot);
  } catch (error: any) {
    logger.warn(`Failed to cleanup podcast directories for ${dirPath}:`, error.message);
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
 * Comprehensive cleanup helper for podcast files - uses extended cleanup range
 */
async function cleanupPodcastFileAndDirectories(filePath: string): Promise<void> {
  try {
    // First, delete the file if it exists
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
      logger.info(`🗑️ Deleted podcast file: ${path.basename(filePath)}`);
    }
    
    // Then clean up empty directories with extended range for podcasts
    const fileDir = path.dirname(filePath);
    await cleanupEmptyPodcastDirectories(fileDir);
  } catch (error: any) {
    logger.warn(`Failed to cleanup podcast file and directories for ${filePath}:`, error.message);
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
export async function downloadVideoWithAudioSimple(videoUrl: string, options: DownloadOptions, metadata?: VideoMetadata): Promise<string> {
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
          videoKey = generateVideoS3Key(videoMetadata, videoExtension, '720p'); // Default to 720p if no specific quality
        } else {
          // Fallback naming
          const filename = path.basename(downloadedPath);
          videoKey = `videos/${filename}`;
        }
        
        const bucketName = getS3ArtifactBucket();
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

export async function downloadContent(url: string): Promise<Buffer | null> {
    if (!url) {
        console.error("Error: No URL provided for download.");
        return null;
    }

    console.log(`Downloading content from: ${url}`);
    try {
        const response = await withSemaphore(httpSemaphore, 'http_fetch', () => withRetry(
          () => fetch(url),
          parseInt(process.env.RETRY_ATTEMPTS || '3', 10),
          parseInt(process.env.RETRY_BASE_DELAY_MS || '500', 10),
          2
        ));
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`Successfully downloaded content from ${url}.`);
        return buffer;
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error downloading content from ${url}: ${error.message}`);
        } else {
            console.error("An unknown error occurred during download.");
        }
        return null;
    }
}
/**
 * Transcodes a video file to a specified resolution using a direct ffmpeg spawn.
 * @param inputPath - The path to the source video file.
 * @param outputPath - The path where the transcoded video will be saved.
 * @param resolution - The target vertical resolution.
 * @returns A promise that resolves when transcoding is complete.
 */
function getCpuCores(): number {
  return computeDefaultConcurrency('cpu');
}

function transcodeRendition(inputPath: string, outputPath: string, resolution: VideoQuality): Promise<void> {
  return withSemaphore(diskSemaphore, 'disk_ffmpeg_transcode', () => new Promise((resolve, reject) => {
        const height = parseInt(resolution.replace('p', ''), 10);
        const threads = Math.max(1, parseInt(process.env.FFMPEG_THREADS || '', 10) || getCpuCores());
        logger.info(`Starting transcoding to ${resolution}...`);

    const args = [
            '-i', inputPath,
            '-vf', `scale=-2:${height}`, 
            '-c:v', 'libx264',
      '-x264-params', `threads=${threads}`,
      '-threads', String(threads),
            '-c:a', 'aac',
            '-y', 
            outputPath
        ];

        const ffmpegProcess = spawn(FFMPEG_PATH, args);
        let ffmpegError = '';

        ffmpegProcess.stderr?.on('data', (data: Buffer) => {
            ffmpegError += data.toString();
        });

        ffmpegProcess.on('error', (error: Error) => {
            logger.error(`Failed to start ffmpeg process for ${resolution} rendition: ${error.message}`);
            reject(error);
        });

    ffmpegProcess.on('close', (code: number | null) => {
            if (code === 0) {
                logger.info(`Finished transcoding to ${resolution}.`);
                resolve();
            } else {
                logger.error(`ffmpeg process for ${resolution} exited with error code ${code}`);
                logger.error(`ffmpeg error output: ${ffmpegError}`);
                reject(new Error(`ffmpeg process exited with code ${code}. Error: ${ffmpegError}`));
            }
        });
  }));
}
async function createAndUploadRenditions(
    originalFilePath: string,
    originalQuality: 1080 | 720,
    s3Service: S3Service,
    metadata: VideoMetadata
): Promise<void> {
    const renditionsToCreate: VideoQuality[] = [];
    if (originalQuality === 1080) {
        renditionsToCreate.push('720p');
    }
    renditionsToCreate.push('480p', '360p');

    const tempDir = path.dirname(originalFilePath);
    const createdFiles: string[] = [];

    for (const quality of renditionsToCreate) {
        const outputFileName = `${path.basename(originalFilePath, path.extname(originalFilePath))}_${quality}.mp4`;
        const outputFilePath = path.join(tempDir, outputFileName);
        createdFiles.push(outputFilePath);

        try {
            // 1. Transcode the video
            await transcodeRendition(originalFilePath, outputFilePath, quality);

            // 2. Upload the transcoded file
            const s3Key = generateLowerDefVideoS3Key(metadata, quality);
            const bucketName = getS3ArtifactBucket();
            await s3Service.uploadFile(outputFilePath, bucketName, s3Key);
            logger.info(`✅ Successfully uploaded ${quality} rendition to S3.`);

        } catch (error) {
            logger.error(`❌ Failed to process ${quality} rendition.`, error instanceof Error ? error : new Error('error instance is undefined'));
            // Continue to the next rendition even if one fails
        }
    }
  }

/**
 * Retry wrapper for operations that may fail due to transient issues
 * @param operation - The async operation to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param baseDelayMs - Base delay between retries in milliseconds (default: 1000)
 * @param backoffMultiplier - Multiplier for exponential backoff (default: 2)
 * @returns Promise with the result of the operation
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  backoffMultiplier: number = 2
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await operation();
      if (attempt > 1) {
        logger.info(`✅ Operation succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt <= maxRetries) {
        const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        logger.warn(`⚠️ Operation failed on attempt ${attempt}/${maxRetries + 1}, retrying in ${delay}ms...`, {
          error: lastError.message,
          attempt,
          maxRetries: maxRetries + 1,
          nextDelay: delay
        });
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        logger.error(`❌ Operation failed after ${maxRetries + 1} attempts`, lastError);
        throw lastError;
      }
    }
  }
  
  throw lastError!;
}

export async function renderingLowerDefinitionVersions(
  finalMergedPath: string,
  metadata: VideoMetadata,
  topEdition: 1080 | 720,
  s3Service?: S3Service | null,
  bucketName?: string
): Promise<{ success: boolean; message?: string; masterPlaylists3Link: string }> {

    const outputDir = path.join(path.dirname(finalMergedPath), 'hls_output');
    const episodeName = sanitizeFilename(metadata.title);
    let masterPlaylists3Link = '';

    const renditions = topEdition === 1080 ? 
        [
            { resolution: '1920x1080', bitrate: '2500k', name: '1080p' },
            { resolution: '1280x720', bitrate: '1200k', name: '720p' },
            { resolution: '854x480', bitrate: '700k', name: '480p' },
            { resolution: '640x360', bitrate: '400k', name: '360p' },
        ] : 
        [
            { resolution: '1280x720', bitrate: '1200k', name: '720p' },
            { resolution: '854x480', bitrate: '700k', name: '480p' },
            { resolution: '640x360', bitrate: '400k', name: '360p' },
        ];

  try {
    // Helper to generate a master playlist if FFmpeg doesn't
    const ensureMasterPlaylist = async () => {
      const masterPath = path.join(outputDir, 'master.m3u8');
      try {
        await fsPromises.access(masterPath);
        // Master exists; nothing to do
        return masterPath;
      } catch {
        logger.warn('⚠️ FFmpeg did not generate master.m3u8; generating manually...');

        // Build a simple HLS master playlist referencing each rendition's playlist
        const lines: string[] = [];
        lines.push('#EXTM3U');
        lines.push('#EXT-X-VERSION:7');

        const parseBitrateToBps = (br: string): number => {
          // Expect formats like '2500k', '1200k'
          const match = br.match(/^(\d+)([kKmM]?)$/);
          if (!match) return 0;
          const value = parseInt(match[1], 10);
          const unit = match[2].toLowerCase();
          if (unit === 'm') return value * 1000 * 1000;
          if (unit === 'k') return value * 1000;
          return value; // already in bps
        };

        for (const r of renditions) {
          const bandwidth = parseBitrateToBps(r.bitrate);
          // Use typical AVC/AAC codec string; adjust if needed
          const codecs = 'avc1.4d401f,mp4a.40.2';
          // r.resolution already like '1280x720'
          lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.resolution},CODECS="${codecs}"`);
          lines.push(`${r.name}/${r.name}.m3u8`);
        }

        await fsPromises.writeFile(masterPath, lines.join('\n'), 'utf-8');
        logger.info('✅ Generated master.m3u8 manually');
        return masterPath;
      }
    };
        await fsPromises.mkdir(outputDir, { recursive: true });

        // --- Start of Optimized FFmpeg Logic ---
        logger.info('🚀 Building a single, unified FFmpeg command for all renditions...');

  const ffmpegArgs: string[] = [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', path.resolve(finalMergedPath), // Single input
        ];

        // 1. Build the complex filter graph to scale all renditions at once
        const filterComplexParts: string[] = [];
        const videoLabels = renditions.map((_, i) => `[v${i}]`).join('');
        const audioLabels = renditions.map((_, i) => `[a${i}]`).join('');
        filterComplexParts.push(`[0:v]split=${renditions.length}${videoLabels}`);
        
        // Add audio normalization and conditioning to prevent AAC encoder issues
        filterComplexParts.push(`[0:a]aresample=44100:resampler=soxr,aformat=channel_layouts=stereo:sample_fmts=fltp,asplit=${renditions.length}${audioLabels}`);
        
        renditions.forEach((r, i) => {
            filterComplexParts.push(`[v${i}]scale=${r.resolution}[outv${i}]`);
        });
        ffmpegArgs.push('-filter_complex', filterComplexParts.join(';'));
        
  // 2. Map the processed streams to outputs and set encoding options for each
        const streamMapVar: string[] = [];
        
        // Add audio codec selection logic to avoid AAC encoder issues
        const getAudioCodecParams = () => {
            // Try to detect if source audio is already AAC and in good quality
            return [
                '-c:a', 'aac',
                '-b:a', '96k',
                '-ac', '2',              // Force stereo output
                '-ar', '44100',          // Set sample rate to 44.1kHz
                '-aac_coder', 'twoloop', // Use twoloop AAC coder (more stable)
                '-avoid_negative_ts', 'make_zero', // Avoid timestamp issues
            ];
        };
        
        const audioCodecParams = getAudioCodecParams();
        
  const cores = getCpuCores();
  // Ensure FFmpeg itself can use all available cores for filtering/muxing as well
  // Place global threads flag before any inputs/options
  ffmpegArgs.unshift('-threads', String(cores));
  // Increase filter graph threads for parallelism on multi-core systems
  ffmpegArgs.unshift('-filter_complex_threads', String(Math.max(1, Math.min(cores, renditions.length * 2))));
  ffmpegArgs.unshift('-filter_threads', String(Math.max(1, Math.floor(cores / 2) || 1)));

  // Optimize thread allocation: distribute available cores across encoders to target ~100% CPU
  // Each encoder gets at least 2 threads; distribute any remainder to the first N encoders.
  const minThreadsPerEncoder = 2;
  const baseThreads = Math.max(minThreadsPerEncoder, Math.floor(cores / renditions.length) || 1);
  let remainder = Math.max(0, cores - baseThreads * renditions.length);
  const perEncoderThreads: number[] = renditions.map((_, idx) => baseThreads + (remainder-- > 0 ? 1 : 0));

  logger.info('FFmpeg thread allocation per rendition', { cores, perEncoderThreads, renditions: renditions.map(r => r.name) });

  renditions.forEach((r, i) => {
            const renditionDir = path.join(outputDir, r.name);
            fsPromises.mkdir(renditionDir, { recursive: true }); // Create sub-directory for each rendition

            ffmpegArgs.push(
                `-map`, `[outv${i}]`,
                `-map`, `[a${i}]`,
                `-c:v`, `libx264`,
                '-preset', 'veryfast',
    '-x264-params', `threads=${perEncoderThreads[i]}:keyint=48:min-keyint=48:scenecut=0`,
                '-b:v', r.bitrate,
                ...audioCodecParams, // Use the robust audio codec parameters
                '-f', 'hls',
                '-hls_flags', 'single_file',
                '-hls_time', '6',
                '-hls_playlist_type', 'vod',
                '-hls_segment_type', 'fmp4',
                path.join(renditionDir, `${r.name}.m3u8`) // Main output is now the playlist
            );
            streamMapVar.push(`v:${i},a:${i}`);
        });

        // 3. Add automatic master playlist generation
        ffmpegArgs.push(
            '-var_stream_map', streamMapVar.join(' '),
            '-master_pl_name', 'master.m3u8'
        );
        
        // Execute the single, powerful command once with AAC encoder fallback logic
        logger.info(`🔥 Executing unified FFmpeg command... This may take a while.`);
        
        const executeFFmpegWithFallback = async (): Promise<void> => {
            try {
                // Try with the default AAC encoder first
                await executeCommand(FFMPEG_PATH, ffmpegArgs, outputDir);
            } catch (error: any) {
                const errorMessage = error.message || String(error);
                
                // Check if it's the specific AAC encoder assertion error
                if (errorMessage.includes('Assertion diff >= 0 && diff <= 120 failed at libavcodec/aacenc.c') ||
                    errorMessage.includes('aacenc.c:684')) {
                    logger.warn('⚠️ AAC encoder assertion error detected, trying fallback with audio copy...');
                    
                    // Create a fallback command that copies audio instead of re-encoding
                    const fallbackArgs = [...ffmpegArgs];
                    
                    // Find and replace AAC encoding parameters with audio copy
                    for (let i = 0; i < fallbackArgs.length; i++) {
                        if (fallbackArgs[i] === '-c:a' && fallbackArgs[i + 1] === 'aac') {
                            fallbackArgs[i + 1] = 'copy'; // Copy audio stream instead of re-encoding
                            // Remove AAC-specific parameters
                            const paramsToRemove = ['-b:a', '-ac', '-ar', '-aac_coder', '-avoid_negative_ts'];
                            let j = i + 2;
                            while (j < fallbackArgs.length) {
                                if (paramsToRemove.includes(fallbackArgs[j])) {
                                    fallbackArgs.splice(j, 2); // Remove parameter and its value
                                } else {
                                    j++;
                                }
                            }
                            break;
                        }
                    }
                    
                    logger.info('🔄 Retrying with audio copy instead of AAC encoding...');
                    await executeCommand(FFMPEG_PATH, fallbackArgs, outputDir);
                    logger.info('✅ Fallback with audio copy succeeded');
                } else {
                    // Re-throw other errors
                    throw error;
                }
            }
        };
        
        await withRetry(executeFFmpegWithFallback, 1, 1500, 2);
    logger.info('✅ All renditions transcoded successfully in a single run.');
        // --- End of Optimized FFmpeg Logic ---

    // Ensure master.m3u8 exists (fallback to manual generation if FFmpeg didn't create it)
    await ensureMasterPlaylist();

    // Conditionally upload to S3 if available; otherwise, skip upload and return empty link
    const masterPathLocal = path.join(outputDir, 'master.m3u8');
    try {
      await fsPromises.access(masterPathLocal);
      logger.info('🧾 master.m3u8 present; proceeding to upload step');
    } catch {
      logger.warn('⚠️ master.m3u8 still not found before upload; upload (if any) will proceed but playback may fail');
    }

    if (s3Service && bucketName) {
      logger.info(`☁️ Uploading HLS files to S3 bucket: ${bucketName}...`);
      const filesToUpload = await fsPromises.readdir(outputDir, { recursive: true });

      const uploadPromises = filesToUpload.map(async (relativeFilePath: string) => {
        const filePath = path.join(outputDir, relativeFilePath);
        const fileStat = await fsPromises.stat(filePath);
        if (fileStat.isFile()) {
          const s3Key = `${create_slug(metadata.uploader)}/${create_slug(episodeName)}/original/video_stream/${relativeFilePath.replace(/\\/g, '/')}`;
          return withRetry(() => s3Service.uploadFile(filePath, bucketName, s3Key), 2, 1000, 2);
        }
      });

      await Promise.all(uploadPromises.filter(p => p));
      logger.info('✅ All HLS files uploaded successfully.');

      const masterPlaylistS3Key = `${create_slug(metadata.uploader)}/${create_slug(episodeName)}/original/video_stream/master.m3u8`;
      masterPlaylists3Link = getPublicUrl(bucketName, masterPlaylistS3Key);
    } else {
      logger.info('📦 S3 not available; skipping HLS upload and returning empty master playlist link');
      masterPlaylists3Link = '';
    }
        
        return { success: true, message: 'Lower definition versions rendered and uploaded.', masterPlaylists3Link };
     } catch (error: any) {
        logger.error(`❌ Error in renderingLowerDefinitionVersions: ${error.message}`, error);
        throw error;
  } finally {
        try {
            logger.info(`🧹 Cleaning up local directory: ${outputDir}...`);
            await fsPromises.rm(outputDir, { recursive: true, force: true });
            logger.info('✅ Cleanup complete.');
        } catch (cleanupError: any) {
            logger.error(`❌ Failed to clean up directory ${outputDir}: ${cleanupError.message}`);
        }
    }
}
const executeCommand = (command: string, args: string[], cwd: string): Promise<void> => {
  return withSemaphore(diskSemaphore, 'disk_ffmpeg_hls', () => new Promise((resolve, reject) => {
        logger.info(`Executing in CWD (${cwd}): ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, { cwd, stdio: 'pipe' });
        
        // Use arrays to collect raw buffer chunks
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        
        proc.stdout?.on('data', (data: Buffer) => stdoutChunks.push(data));
        proc.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
        
        proc.on('error', (error) => {
            logger.error(`Failed to start process ${command}`, error);
            reject(new Error(`Failed to start process: ${error.message}`));
        });
        
    proc.on('close', code => {
            const stderrOutput = Buffer.concat(stderrChunks).toString('utf-8');
            const stdoutOutput = Buffer.concat(stdoutChunks).toString('utf-8');

            if (code === 0) {
                logger.debug(`Command completed successfully: ${command}`);
                resolve();
            } else {
                const errorMessage = `${command} exited with code ${code}`;
                // Now, stderrOutput will reliably contain just the error message
                logger.error(errorMessage, undefined, { 
                    command,
                    args: args.join(' '),
                    cwd,
                    exitCode: code,
                    stderr: stderrOutput, // Log the full, clean error
                    stdout: stdoutOutput
                });
                reject(new Error(`${errorMessage}\nFFmpeg stderr:\n${stderrOutput}`));
            }
        });
  }));
};

/**
 * Manually write a master.m3u8 using existing rendition playlists in an HLS folder.
 * Looks for subfolders like 1080p, 720p, 480p, 360p containing <name>/<name>.m3u8.
 * Only includes variants that exist. Bitrates and resolutions use sensible defaults.
 *
 * @param outputDir Directory that contains rendition subfolders (e.g., hls_output)
 * @param definitions Preferred order of definitions to include (default: ["720p","480p","360p"]).
 * @returns Absolute path to the written master.m3u8
 */
export async function writeMasterM3U8FromRenditions(
  outputDir: string,
  definitions: string[] = ["720p", "480p", "360p"]
): Promise<string> {
  // Map common definitions to typical resolution and bandwidth (in bps)
  const DEF_MAP: Record<string, { resolution: string; bandwidth: number }> = {
    "1080p": { resolution: "1920x1080", bandwidth: 2500000 },
    "720p": { resolution: "1280x720", bandwidth: 1200000 },
    "480p": { resolution: "854x480", bandwidth: 700000 },
    "360p": { resolution: "640x360", bandwidth: 400000 },
  };

  const codecs = 'avc1.4d401f,mp4a.40.2';
  const masterPath = path.join(outputDir, 'master.m3u8');

  try {
    await fsPromises.mkdir(outputDir, { recursive: true });
  } catch (e) {
    // directory creation failure will surface during write; continue
  }

  // Build lines for the master playlist
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
  ];

  let included = 0;
  for (const def of definitions) {
    const rel = `${def}/${def}.m3u8`;
    const full = path.join(outputDir, rel);
    try {
      await fsPromises.access(full, fs.constants.R_OK);
      const info = DEF_MAP[def] || { resolution: '1280x720', bandwidth: 1200000 };
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${info.bandwidth},RESOLUTION=${info.resolution},CODECS="${codecs}"`);
      lines.push(rel);
      included++;
    } catch {
      logger.warn(`Skipping missing rendition playlist: ${rel}`);
    }
  }

  if (included === 0) {
    const msg = `No rendition playlists found in ${outputDir}; cannot write master.m3u8`;
    logger.error(msg);
    throw new Error(msg);
  }

  const content = lines.join('\n') + '\n';
  await fsPromises.writeFile(masterPath, content, 'utf-8');
  logger.info(`✅ Wrote master.m3u8 with ${included} variant(s)`, { masterPath });
  return masterPath;
}
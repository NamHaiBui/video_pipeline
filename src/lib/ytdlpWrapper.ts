import { execFile, spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { VideoMetadata, ProgressInfo, DownloadOptions, CommandResult } from '../types.js';
import { S3Service, createS3ServiceFromEnv } from './s3Service.js';
import { DynamoDBService, createDynamoDBServiceFromEnv } from './dynamoService.js';
import { isValidYouTubeUrl } from './urlUtils.js';
import { generateAudioS3Key, generateVideoS3Key, getAudioBucketName, getVideoBucketName } from './s3KeyUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths to Local Binaries ---
const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg');

// Podcast processing constants
const PODCAST = {
  MIN_DURATION_MINUTES: 5,
  PREFERRED_AUDIO_FORMATS: ['mp3', 'opus', 'aac', 'm4a'],
  DEFAULT_AUDIO_QUALITY: 'bestaudio[ext=mp3]/bestaudio',
} as const;

const PODCAST_INDICATORS = {
  TITLE_KEYWORDS: [
    'podcast', 'interview', 'talk', 'discussion', 'conversation',
    'episode', 'show', 'radio', 'chat', 'dialogue'
  ],
  DESCRIPTION_KEYWORDS: [
    'subscribe', 'episode', 'guest', 'host', 'interview',
    'podcast', 'discussion', 'listen', 'audio'
  ],
  CHANNEL_INDICATORS: [
    'podcast', 'radio', 'interview', 'talk show', 'discussions'
  ],
} as const;

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
 * Check if content appears to be podcast-like based on metadata
 */
function isPodcastContent(metadata: VideoMetadata): boolean {
  const title = (metadata.title || '').toLowerCase();
  const description = (metadata.description || '').toLowerCase();
  const uploader = (metadata.uploader || '').toLowerCase();
  
  // Check title for podcast indicators
  const titleMatch = PODCAST_INDICATORS.TITLE_KEYWORDS.some(keyword => 
    title.includes(keyword.toLowerCase())
  );
  
  // Check description for podcast indicators
  const descriptionMatch = PODCAST_INDICATORS.DESCRIPTION_KEYWORDS.some(keyword => 
    description.includes(keyword.toLowerCase())
  );
  
  // Check channel name for podcast indicators
  const channelMatch = PODCAST_INDICATORS.CHANNEL_INDICATORS.some(keyword => 
    uploader.includes(keyword.toLowerCase())
  );
  
  // Check duration (podcasts are typically longer)
  const durationMatch = metadata.duration ? metadata.duration >= (PODCAST.MIN_DURATION_MINUTES * 60) : false;
  
  return titleMatch || descriptionMatch || channelMatch || durationMatch;
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
      // Default to MP3 for best compatibility
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
    const browserHeaders = [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language: en-US,en;q=0.9',
    'Accept-Encoding: gzip, deflate, br',
    'DNT: 1',
    'Upgrade-Insecure-Requests: 1',
    'Sec-Fetch-Dest: document',
    'Sec-Fetch-Mode: navigate',
    'Sec-Fetch-Site: none',
    'Sec-Fetch-User: ?1',
    'Cache-Control: max-age=0'
  ];
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
    // '--cookies-from-browser', 'firefox',
    // '--extractor-args','youtube:player_client=web', 
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
    console.warn(`Cookies file not found at ${options.cookiesFile}, proceeding without it.`);
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
      console.log('Progress:', progressData);
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
      return match[1].trim();
    }
  }
  return null;
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
    console.warn(`Cookies file not found at ${options.cookiesFile}, proceeding without it.`);
  }

  // Add additional headers if specified
  if (options.additionalHeaders) {
    options.additionalHeaders.forEach(header => {
      args.push('--add-header', header);
    });
  }

  args.push(videoUrl);

  console.log(`Fetching metadata for: ${videoUrl}`);
  console.log(`Executing: ${YTDLP_PATH} ${args.join(' ')}`); 
  
  try {
    const { stdout, stderr } = await new Promise<CommandResult>((resolve, reject) => {
      execFile(YTDLP_PATH, args, (error, stdout, stderr) => {
        if (error) {
          console.error(`yt-dlp execution error (execFile): ${error.message}`);
          if (stderr) {
            console.error(`yt-dlp stderr (execFile): ${stderr}`);
          }
          (error as any).stderrContent = stderr;
          return reject(error);
        }
        resolve({ stdout, stderr });
      });
    });

    if (stderr && !stderr.toLowerCase().includes('downloading webpage') && !stderr.toLowerCase().includes('extracting data')) {
        console.warn('yt-dlp messages during metadata fetch (stderr):', stderr.trim());
    }
    
    try {
      const metadata = JSON.parse(stdout) as VideoMetadata;
      
      // Save metadata to DynamoDB if service is available
      try {
        const dynamoService = createDynamoDBServiceFromEnv();
        if (dynamoService) {
          console.log('💾 Saving video metadata to DynamoDB...');
          const saveSuccess = await dynamoService.saveVideoMetadata(metadata);
          if (saveSuccess) {
            console.log(`✅ Metadata for video ${metadata.id} saved to DynamoDB successfully`);
          } else {
            console.warn(`⚠️ Failed to save metadata for video ${metadata.id} to DynamoDB`);
          }
        } else {
          console.log('ℹ️ DynamoDB service not available, skipping metadata save');
        }
      } catch (dynamoError: any) {
        console.warn('⚠️ DynamoDB save error (continuing with metadata return):', dynamoError.message);
      }
      
      return metadata;
    } catch (parseError: any) {
      console.error(`Failed to parse JSON metadata for ${videoUrl}: ${parseError.message}`);
      console.error('Raw stdout from yt-dlp (metadata):', stdout);
      throw new Error(`Failed to parse JSON metadata for ${videoUrl}. Raw output: ${stdout.substring(0, 200)}...`);
    }
  } catch (error: any) {
    console.error(`Failed to fetch or parse metadata for ${videoUrl}: ${error.message}`);
    if (error.stderrContent) {
        console.error('Detailed error from yt-dlp (metadata):', error.stderrContent);
    }
    throw error;
  }
}

export function downloadPodcastAudioWithProgress(videoUrl: string, options: DownloadOptions = {}): Promise<string> {
  checkBinaries();
  return new Promise((resolve, reject) => {
    const outputDir = options.outputDir || PODCAST_OUTPUT_DIR;
    const outputFilenameTemplate = options.outputFilename || '%(uploader)s - %(title)s [%(id)s].%(ext)s';
    const format = options.format || getPodcastAudioFormat();
    
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPathAndFilename = path.join(outputDir, outputFilenameTemplate);
    
    const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options, ['-x']);

    console.log(`Starting podcast audio download for: ${videoUrl}`);
    console.log(`Using format: ${format}`);
    console.log(`Executing: ${YTDLP_PATH} ${baseArgs.join(' ')}`);
    
    const ytdlpProcess: ChildProcess = spawn(YTDLP_PATH, baseArgs); 
    let downloadedFilePath = '';
    
    ytdlpProcess.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        handleProgressData(line, options);
        
        const detectedPath = handleDownloadPath(line);
        if (detectedPath) {
            downloadedFilePath = detectedPath;
            console.log(`yt-dlp process: ${line}`);
        } else if (line && !line.startsWith('download-status:')) {
            console.log(`yt-dlp stdout: ${line}`);
        }
    });
    
    ytdlpProcess.stderr?.on('data', (data: Buffer) => {
        console.warn(`yt-dlp stderr: ${data.toString().trim()}`);
    });
    
    ytdlpProcess.on('error', (error: Error) => {
        console.error(`Failed to start yt-dlp process: ${error.message}`);
        reject(error);
    }); 
    
    ytdlpProcess.on('close', async (code: number | null) => {
        if (code === 0) {
            if (options.onProgress) options.onProgress({
                percent: '100%',
                eta: '0s',
                speed: '',
                raw: 'Podcast Audio Download Complete'
            });
            const finalPath = downloadedFilePath || outputPathAndFilename.replace(/%\([\w_]+\)\w/g, '').replace('[]', '').trim();
            console.log(`Podcast audio download finished successfully (exit code ${code}). Output: ${finalPath}`);
            
            // Upload to S3 if enabled
            if (options.s3Upload?.enabled) {
                try {
                    const s3Service = createS3ServiceFromEnv();
                    if (s3Service) {
                        console.log('🚀 Uploading podcast audio to S3...');
                        
                        // Get video metadata to create proper slug-based naming
                        let videoMetadata = null;
                        try {
                          videoMetadata = await getVideoMetadata(videoUrl);
                        } catch (metaError) {
                          console.warn('Could not fetch metadata for S3 naming, using fallback', metaError);
                        }
                        
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
                            console.log(`✅ Podcast audio uploaded to S3: ${uploadResult.location}`);
                            
                            // Always delete local file after successful S3 upload (ephemeral storage)
                            try {
                                await s3Service.deleteLocalFile(finalPath);
                                console.log(`🗑️ Deleted local audio file after S3 upload: ${path.basename(finalPath)}`);
                            } catch (deleteError) {
                                console.warn(`⚠️ Failed to delete local audio file: ${deleteError}`);
                            }
                        } else {
                            console.error(`❌ Failed to upload podcast audio to S3: ${uploadResult.error}`);
                        }
                    } else {
                        console.warn('⚠️ S3 service not available, skipping upload');
                    }
                } catch (error: any) {
                    console.error('❌ Error during S3 upload:', error.message);
                }
            }
            
            resolve(finalPath);
        } else {
            console.error(`yt-dlp process exited with error code ${code}.`);
            reject(new Error(`yt-dlp process exited with code ${code}. Check logs.`));
        }
    });
  });
}
export function downloadVideoNoAudioWithProgress(videoUrl: string, options: DownloadOptions = {}): Promise<string> {
    checkBinaries();
    return new Promise((resolve, reject) => {
        const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
        const outputFilenameTemplate = options.outputFilename || '%(title)s [%(id)s].%(ext)s';
        const format = options.format || 'bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]/bestvideo[ext=mp4]/best[ext=mp4]/best';

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        const outputPathAndFilename = path.join(outputDir, outputFilenameTemplate);

        const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options);

        console.log(`Starting video-only download for: ${videoUrl}`);
        console.log(`Executing: ${YTDLP_PATH} ${baseArgs.join(' ')}`);

        const ytdlpProcess: ChildProcess = spawn(YTDLP_PATH, baseArgs);
        let downloadedFilePath = ''; 

        ytdlpProcess.stdout?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            handleProgressData(line, options);
            
            const detectedPath = handleDownloadPath(line);
            if (detectedPath) {
                downloadedFilePath = detectedPath;
                console.log(`yt-dlp process: ${line}`);
            } else if (line && !line.startsWith('download-status:')) {
                console.log(`yt-dlp stdout: ${line}`);
            }
        });

        ytdlpProcess.stderr?.on('data', (data: Buffer) => {
            console.warn(`yt-dlp stderr: ${data.toString().trim()}`); 
        });

        ytdlpProcess.on('error', (error: Error) => {
            console.error(`Failed to start yt-dlp process: ${error.message}`);
            reject(error);
        });

        ytdlpProcess.on('close', (code: number | null) => {
            if (code === 0) {
                if (options.onProgress) options.onProgress({ 
                    percent: '100%', 
                    eta: '0s', 
                    speed: '', 
                    raw: 'Download Complete' 
                });
                const finalPath = downloadedFilePath || outputPathAndFilename.replace(/%\([\w_]+\)\w/g, '').replace('[]', '').trim();
                console.log(`Video-only download finished successfully (exit code ${code}). Output: ${finalPath}`);
                resolve(finalPath);
            } else {
                console.error(`yt-dlp process exited with error code ${code}.`);
                reject(new Error(`yt-dlp process exited with code ${code}. Check logs.`));
            }
        });
    });
}
export function downloadVideoWithProgress(videoUrl: string, options: DownloadOptions = {}): Promise<string> {
  checkBinaries();
  return new Promise((resolve, reject) => {
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    const outputFilenameTemplate = options.outputFilename || '%(title)s [%(id)s].%(ext)s';
    const format = options.format || 'bestvideo[height<=480]+bestaudio/best[height<=480]/bestvideo+bestaudio/best';

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPathAndFilename = path.join(outputDir, outputFilenameTemplate);

    const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options, ['-k']);

    console.log(`Starting video download for: ${videoUrl}`);
    console.log(`Executing: ${YTDLP_PATH} ${baseArgs.join(' ')}`);

    const ytdlpProcess: ChildProcess = spawn(YTDLP_PATH, baseArgs);
    let downloadedFilePath = '';

    ytdlpProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      handleProgressData(line, options);
      
      const detectedPath = handleDownloadPath(line);
      if (detectedPath) {
        downloadedFilePath = detectedPath;
        console.log(`yt-dlp process: ${line}`);
      } else if (line && !line.startsWith('download-status:')) {
        console.log(`yt-dlp stdout: ${line}`);
      }
    });

    ytdlpProcess.stderr?.on('data', (data: Buffer) => {
      console.warn(`yt-dlp stderr: ${data.toString().trim()}`); 
    });

    ytdlpProcess.on('error', (error: Error) => {
      console.error(`Failed to start yt-dlp process: ${error.message}`);
      reject(error);
    });

    ytdlpProcess.on('close', (code: number | null) => {
      if (code === 0) {
        if (options.onProgress) options.onProgress({ 
          percent: '100%', 
          eta: '0s', 
          speed: '', 
          raw: 'Download Complete' 
        });
        const finalPath = downloadedFilePath || outputPathAndFilename.replace(/%\([\w_]+\)\w/g, '').replace('[]', '').trim();
        
        // Validate the downloaded file
        if (fs.existsSync(finalPath)) {
          const stats = fs.statSync(finalPath);
          if (stats.size > 1024) { // File exists and has reasonable size
            console.log(`Video download finished successfully (exit code ${code}). Output: ${finalPath}`);
            console.log(`📁 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            resolve(finalPath);
            return;
          }
        }
        
        // If we reach here, the file is missing or too small
        console.warn(`Downloaded file is missing or too small, falling back to separate download+merge...`);
        downloadAndMergeVideo(videoUrl, options)
          .then(resolve)
          .catch(reject);
      } else {
        console.error(`yt-dlp process exited with error code ${code}. Attempting fallback to separate download+merge...`);
        // Fallback to separate download and merge
        downloadAndMergeVideo(videoUrl, options)
          .then(resolve)
          .catch((fallbackError) => {
            reject(new Error(`Both direct download and fallback failed. Direct: code ${code}, Fallback: ${fallbackError.message}`));
          });
      }
    });
  });
}
export function mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string, options: DownloadOptions = {}): Promise<string> {
  checkBinaries();
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-y',
      outputPath
    ];

    console.log(`Merging video and audio: ${FFMPEG_PATH} ${args.join(' ')}`);

    const ffmpegProcess = spawn(FFMPEG_PATH, args);

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      console.log(`ffmpeg: ${data.toString().trim()}`);
    });

    ffmpegProcess.on('error', (error: Error) => {
      console.error(`Failed to start ffmpeg process: ${error.message}`);
      reject(error);
    });

    ffmpegProcess.on('close', (code: number | null) => {
      if (code === 0) {
        console.log(`Merge completed successfully. Output: ${outputPath}`);
        resolve(outputPath);
      } else {
        console.error(`ffmpeg process exited with error code ${code}`);
        reject(new Error(`ffmpeg process exited with code ${code}`));
      }
    });
  });
}

/**
 * Download video and audio separately, then merge them into a single file
 */
export function downloadAndMergeVideo(videoUrl: string, options: DownloadOptions = {}): Promise<any> {
  checkBinaries();
  return new Promise(async (resolve, reject) => {
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    const outputFilenameTemplate = options.outputFilename || '%(title)s [%(id)s].%(ext)s';
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Create temp directory for separate video/audio files
    const tempDir = path.join(outputDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let tempVideoPath = '';
    let tempAudioPath = '';
    let finalMergedPath = '';

    try {
      console.log(`Starting video+audio download and merge for: ${videoUrl}`);

      // Start both downloads simultaneously
      console.log('Starting parallel download of video and audio streams...');
      
      const videoDownloadPromise = downloadVideoNoAudioWithProgress(videoUrl, {
        ...options,
        outputDir: tempDir,
        outputFilename: `video_${Date.now()}_${outputFilenameTemplate}`,
        onProgress: (progress: ProgressInfo) => {
          if (options.onProgress) {
            options.onProgress({
              ...progress,
              raw: `Video: ${progress.raw}`
            });
          }
        }
      });

      const audioDownloadPromise = downloadPodcastAudioWithProgress(videoUrl, {
        ...options,
        outputDir: tempDir,
        outputFilename: `audio_${Date.now()}_${outputFilenameTemplate.replace('.%(ext)s', '.%(ext)s')}`,
        onProgress: (progress: ProgressInfo) => {
          if (options.onProgress) {
            options.onProgress({
              ...progress,
              raw: `Audio: ${progress.raw}`
            });
          }
        }
      });

      // Don't wait for both - handle them separately so we can process audio immediately
      console.log('Processing audio and video downloads separately...');
      
      // Handle audio download separately to upload immediately when it's done
      let uploadedAudioInfo = null;
      const audioPromise = audioDownloadPromise.then(async (audioPath: string) => {
        tempAudioPath = audioPath;
        console.log(`Audio download completed successfully: ${audioPath}`);
        
        // Upload audio to S3 immediately if S3 is enabled
        if (options.onProgress) {
          options.onProgress({
            percent: '100%',
            eta: '0s',
            speed: '',
            raw: `Audio: Download completed, uploading to S3...`
          });
        }
        
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service && isValidYouTubeUrl(videoUrl)) {
            // Get video metadata to create proper slug-based naming
            let videoMetadata = null;
            try {
              videoMetadata = await getVideoMetadata(videoUrl);
            } catch (metaError) {
              console.warn('Could not fetch metadata for S3 naming, using fallback', metaError);
            }
            
            let s3AudioKey: string;
            if (videoMetadata) {
              s3AudioKey = generateAudioS3Key(videoMetadata);
            } else {
              // Fallback to video ID if metadata unavailable
              const videoId = new URL(videoUrl).searchParams.get('v');
              s3AudioKey = videoId ? `audio/${videoId}.mp3` : `audio/audio_${Date.now()}.mp3`;
            }
            
            console.log(`Immediately uploading audio file to S3: ${s3AudioKey}`);
            const bucketName = getAudioBucketName();
            const uploadResult = await s3Service.uploadFile(audioPath, bucketName, s3AudioKey);
            
            if (uploadResult.success) {
              console.log(`✅ Audio immediately uploaded to S3: ${uploadResult.location}`);
              uploadedAudioInfo = {
                bucket: uploadResult.bucket,
                key: uploadResult.key,
                location: uploadResult.location
              };
              
              if (options.onProgress) {
                options.onProgress({
                  percent: '100%',
                  eta: '0s',
                  speed: '',
                  raw: `Audio: Upload to S3 completed!`
                });
              }
            } else {
              console.error(`❌ Failed to upload audio to S3: ${uploadResult.error}`);
            }
          }
        } catch (error: any) {
          console.error(`❌ Error uploading audio to S3: ${error.message}`);
        }
        
        return audioPath;
      });
      
      // Wait for video download
      tempVideoPath = await videoDownloadPromise;
      console.log(`Video download completed successfully: ${tempVideoPath}`);
      
      // Wait for audio processing to complete before proceeding
      await audioPromise;
      
      console.log('Both downloads processed successfully!');
      console.log(`Video: ${tempVideoPath}`);
      console.log(`Audio: ${tempAudioPath}`);
      
      // Store the audio path and upload info for later use
      const audioOnlyPath = tempAudioPath;
      const audioS3Info = uploadedAudioInfo;

      // Generate final merged file path
      finalMergedPath = path.join(outputDir, outputFilenameTemplate.replace('%(ext)s', 'mp4'));
      
      // Use metadata to generate proper filename if available
      if (options.outputFilename) {
        finalMergedPath = path.join(outputDir, options.outputFilename.replace('%(ext)s', 'mp4'));
      } else {
        // Create a fallback filename
        const timestamp = Date.now();
        finalMergedPath = path.join(outputDir, `merged_video_${timestamp}.mp4`);
      }

      console.log('Starting merge of video and audio streams...');
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

      console.log('Cleaning up temporary video file...');
      // Clean up temp video file only, keep audio file for later use
      try {
        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
      } catch (cleanupError) {
        console.warn('Warning: Failed to clean up temporary video file:', cleanupError);
      }

      if (options.onProgress) {
        options.onProgress({
          percent: '100%',
          eta: '0s',
          speed: '',
          raw: 'Download and merge complete!'
        });
      }

      // Create a result object that includes the merged path and audio information
      const resultObj = {
        mergedPath: finalMergedPath,
        audioPath: audioOnlyPath,
        audioS3Info: audioS3Info
      };
      
      // Return the result object instead of just the string

      console.log(`Video download and merge completed successfully: ${resultObj.mergedPath}`);
      console.log(`Audio downloaded to: ${resultObj.audioPath}`);
      
      // Upload to S3 if enabled
      if (options.s3Upload?.enabled) {
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            console.log('🚀 Uploading merged video file to S3...');
            
            // Get video metadata to create proper slug-based naming
            let videoMetadata = null;
            try {
              videoMetadata = await getVideoMetadata(videoUrl);
            } catch (metaError) {
              console.warn('Could not fetch metadata for S3 naming, using fallback', metaError);
            }
            
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
              console.log(`✅ Video uploaded to S3: ${uploadResult.location}`);
              
              // Always delete local file after successful S3 upload (ephemeral storage)
              try {
                await s3Service.deleteLocalFile(finalMergedPath);
                console.log(`🗑️ Deleted local video file after S3 upload: ${path.basename(finalMergedPath)}`);
              } catch (deleteError) {
                console.warn(`⚠️ Failed to delete local video file: ${deleteError}`);
              }
            } else {
              console.error(`❌ Failed to upload video to S3: ${uploadResult.error}`);
            }
          } else {
            console.warn('⚠️ S3 service not available, skipping upload');
          }
        } catch (error: any) {
          console.error('❌ Error during S3 video upload:', error.message);
        }
      }
      
      resolve(resultObj);

    } catch (error: any) {
      console.error(`Error during download and merge process: ${error.message}`);
      
      // Clean up temp files on error
      try {
        if (tempVideoPath && fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
        if (tempAudioPath && fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
      } catch (cleanupError) {
        console.warn('Warning: Failed to clean up temporary files after error:', cleanupError);
      }
      
      reject(error);
    }
  });
}
/**
 * Enhanced mergeVideoAudio function with validation
 */
export function mergeVideoAudioWithValidation(videoPath: string, audioPath: string, outputPath: string, options: DownloadOptions = {}): Promise<string> {
  checkBinaries();
  
  return new Promise((resolve, reject) => {
    // Pre-merge validation
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file does not exist: ${videoPath}`));
    }
    if (!fs.existsSync(audioPath)) {
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

    console.log(`📹 Video file: ${(videoStats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`🔊 Audio file: ${(audioStats.size / 1024 / 1024).toFixed(2)} MB`);

    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-y',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      outputPath
    ];

    console.log(`Merging video and audio: ${FFMPEG_PATH} ${args.join(' ')}`);

    const ffmpegProcess = spawn(FFMPEG_PATH, args);
    let ffmpegOutput = '';
    let ffmpegError = '';

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      ffmpegError += output + '\n';
      console.log(`ffmpeg: ${output}`);
    });

    ffmpegProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      ffmpegOutput += output + '\n';
      console.log(`ffmpeg stdout: ${output}`);
    });

    ffmpegProcess.on('error', (error: Error) => {
      console.error(`Failed to start ffmpeg process: ${error.message}`);
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

        console.log(`✅ Merge completed successfully. Output: ${outputPath}`);
        console.log(`📁 Merged file size: ${(mergedStats.size / 1024 / 1024).toFixed(2)} MB`);
        resolve(outputPath);
      } else {
        console.error(`❌ ffmpeg process exited with error code ${code}`);
        console.error(`ffmpeg error output: ${ffmpegError}`);
        reject(new Error(`ffmpeg process exited with code ${code}. Error: ${ffmpegError}`));
      }
    });
  });
}
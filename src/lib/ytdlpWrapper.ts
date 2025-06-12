import { execFile, spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { VideoMetadata, ProgressInfo, DownloadOptions, CommandResult } from '../types.js';
import { S3Service, createS3ServiceFromEnv } from './s3Service.js';
import { DynamoDBService, createDynamoDBServiceFromEnv } from './dynamoService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths to Local Binaries ---
const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg'); 
// Default output directory for downloads
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'downloads');

// Ensure default output directory exists
if (!fs.existsSync(DEFAULT_OUTPUT_DIR)) {
  fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
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

export function downloadVideoAudioOnlyWithProgress(videoUrl: string, options: DownloadOptions = {}): Promise<string> {
  checkBinaries();
  return new Promise((resolve, reject) => {
    const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    const outputFilenameTemplate = options.outputFilename || '%(title)s [%(id)s].%(ext)s';
    const format = options.format || 'bestaudio[ext=mp3]/bestaudio';
    
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPathAndFilename = path.join(outputDir,'audio', outputFilenameTemplate);
    
    const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options, ['-x']);

    console.log(`Starting audio download for: ${videoUrl}`);
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
                raw: 'Download Complete'
            });
            const finalPath = downloadedFilePath || outputPathAndFilename.replace(/%\([\w_]+\)\w/g, '').replace('[]', '').trim();
            console.log(`Audio download finished successfully (exit code ${code}). Output: ${finalPath}`);
            
            // Upload to S3 if enabled
            if (options.s3Upload?.enabled) {
                try {
                    const s3Service = createS3ServiceFromEnv();
                    if (s3Service) {
                        console.log('🚀 Uploading audio file to S3...');
                        const uploadResult = await s3Service.uploadAudioFile(finalPath, options.s3Upload.audioKeyPrefix);
                        
                        if (uploadResult.success) {
                            console.log(`✅ Audio uploaded to S3: ${uploadResult.location}`);
                            
                            // Delete local file if requested
                            if (options.s3Upload.deleteLocalAfterUpload) {
                                await s3Service.deleteLocalFile(finalPath);
                            }
                        } else {
                            console.error(`❌ Failed to upload audio to S3: ${uploadResult.error}`);
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
        const format = options.format || 'bestvideo[ext=mp4]/best[ext=mp4]/best';

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
    const format = options.format || 'bestvideo+bestaudio/best';

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
export function downloadAndMergeVideo(videoUrl: string, options: DownloadOptions = {}): Promise<string> {
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

      const audioDownloadPromise = downloadVideoAudioOnlyWithProgress(videoUrl, {
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

      // Wait for both downloads to complete
      console.log('Waiting for both video and audio downloads to complete...');
      const [videoPath, audioPath] = await Promise.all([videoDownloadPromise, audioDownloadPromise]);
      
      tempVideoPath = videoPath;
      tempAudioPath = audioPath;

      console.log('Both downloads completed successfully!');
      console.log(`Video: ${tempVideoPath}`);
      console.log(`Audio: ${tempAudioPath}`);

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

      console.log('Cleaning up temporary files...');
      // Clean up temp files
      try {
        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
      } catch (cleanupError) {
        console.warn('Warning: Failed to clean up temporary files:', cleanupError);
      }

      if (options.onProgress) {
        options.onProgress({
          percent: '100%',
          eta: '0s',
          speed: '',
          raw: 'Download and merge complete!'
        });
      }

      console.log(`Video download and merge completed successfully: ${finalMergedPath}`);
      
      // Upload to S3 if enabled
      if (options.s3Upload?.enabled) {
        try {
          const s3Service = createS3ServiceFromEnv();
          if (s3Service) {
            console.log('🚀 Uploading merged video file to S3...');
            const uploadResult = await s3Service.uploadVideoFile(finalMergedPath, options.s3Upload.videoKeyPrefix);
            
            if (uploadResult.success) {
              console.log(`✅ Video uploaded to S3: ${uploadResult.location}`);
              
              // Delete local file if requested
              if (options.s3Upload.deleteLocalAfterUpload) {
                await s3Service.deleteLocalFile(finalMergedPath);
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
      
      resolve(finalMergedPath);

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
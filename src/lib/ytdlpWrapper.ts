import { execFile, spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { VideoMetadata, ProgressInfo, DownloadOptions, CommandResult } from '../types.js';

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
  options: DownloadOptions = {cookiesFile: '.config/yt-dlp/cookies.txt'},
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
    '--plugin-dirs','.config/yt-dlp/',
    '-N', '4',
    '--progress',
    '--progress-template', 'download-status:%(progress._percent_str)s ETA %(progress.eta)s SPEED %(progress.speed)s TOTAL %(progress.total_bytes_str)s',
    '--no-continue',
    // '--extractor-args','youtube:player_client=web', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
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
  browserHeaders.forEach(header => {
    baseArgs.push('--add-header', header);
  });
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

export async function getVideoMetadata(videoUrl: string, options: DownloadOptions = {cookiesFile: '.config/yt-dlp/cookies.txt'}): Promise<VideoMetadata> {
  checkBinaries();
  let args = [
    '--dump-json',
    '--no-warnings',
    '--plugin-dirs','.config/yt-dlp/',
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
      return JSON.parse(stdout) as VideoMetadata;
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
    const format = options.format || 'bestaudio[ext=m4a]/best[ext=m4a]/best';
    
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPathAndFilename = path.join(outputDir, outputFilenameTemplate);
    
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
    
    ytdlpProcess.on('close', (code: number | null) => {
        if (code === 0) {
            if (options.onProgress) options.onProgress({
                percent: '100%',
                eta: '0s',
                speed: '',
                raw: 'Download Complete'
            });
            const finalPath = downloadedFilePath || outputPathAndFilename.replace(/%\([\w_]+\)\w/g, '').replace('[]', '').trim();
            console.log(`Audio download finished successfully (exit code ${code}). Output: ${finalPath}`);
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
    const format = options.format || 'bestvideo[ext=mp4]+bestaudio[ext=mp4]/best[ext=mp4]/best';

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPathAndFilename = path.join(outputDir, outputFilenameTemplate);

    const baseArgs = buildYtdlpArgs(videoUrl, outputPathAndFilename, format, options, ['-k']);

    console.log(`Starting download for: ${videoUrl}`);
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
        console.log(`Download finished successfully (exit code ${code}). Output: ${finalPath}`);
        resolve(finalPath);
      } else {
        console.error(`yt-dlp process exited with error code ${code}.`);
        reject(new Error(`yt-dlp process exited with code ${code}. Check logs.`));
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
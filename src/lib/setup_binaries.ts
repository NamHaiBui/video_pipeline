import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import axios, { AxiosResponse } from 'axios';
import ProgressBar from 'progress';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');

// Ensure the bin directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

// --- yt-dlp Setup ---
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'; // For Linux
const YTDLP_FINAL_PATH = path.join(BIN_DIR, 'yt-dlp');

// --- FFmpeg Setup ---
const FFMPEG_DOWNLOAD_COMMAND = 'wget -O - -q  https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz | xz -qdc | tar -x';
const FFMPEG_EXPECTED_EXTRACTED_DIR_PATTERN = /^ffmpeg-master-latest-linux\d+-\w+/;
const FFMPEG_EXE_NAME = 'ffmpeg';
const FFPROBE_EXE_NAME = 'ffprobe'; 
const FFMPEG_FINAL_PATH = path.join(BIN_DIR, FFMPEG_EXE_NAME);
const FFPROBE_FINAL_PATH = path.join(BIN_DIR, FFPROBE_EXE_NAME);

async function downloadFileWithProgress(url: string, outputPath: string, fileNameForProgress: string): Promise<void> {
  console.log(`Downloading ${fileNameForProgress} from ${url} to ${outputPath}...`);
  try {
    const response: AxiosResponse = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
    });

    const { data, headers } = response;
    const totalLength = headers['content-length'];
    const totalLengthNum = parseInt(totalLength as string) || 0;
    
    let progressBar: ProgressBar | null = null;
    
    // Only create progress bar if we have a valid content length
    if (totalLengthNum > 0) {
      progressBar = new ProgressBar(`-> ${fileNameForProgress} [:bar] :percent :etas`, {
        width: 40,
        complete: '=',
        incomplete: ' ',
        renderThrottle: 100,
        total: totalLengthNum,
      });
    } else {
      console.log(`Downloading ${fileNameForProgress}... (size unknown)`);
    }

    const writer = fs.createWriteStream(outputPath);
    data.on('data', (chunk: Buffer) => {
      if (progressBar && totalLengthNum > 0) {
        progressBar.tick(chunk.length);
      }
    });
    data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error: any) {
    console.error(`Error downloading ${fileNameForProgress}: ${error.message}`);
    throw error;
  }
}

async function setupBinaries(): Promise<void> {
  logger.info('Setting up binaries');

  if (!fs.existsSync(YTDLP_FINAL_PATH)) {
    await downloadFileWithProgress(YTDLP_URL, YTDLP_FINAL_PATH, 'yt-dlp');
    fs.chmodSync(YTDLP_FINAL_PATH, '755');
    logger.info('yt-dlp downloaded and made executable');
  } else {
    logger.info('yt-dlp already exists', { path: YTDLP_FINAL_PATH });
  }

  if (!fs.existsSync(FFMPEG_FINAL_PATH)) {
    console.log('ffmpeg not found, attempting download and extraction using shell command...');
    console.log(`Executing: ${FFMPEG_DOWNLOAD_COMMAND} (in directory ${BIN_DIR})`);

    try {
      execSync(FFMPEG_DOWNLOAD_COMMAND, { cwd: BIN_DIR, stdio: 'inherit' });
      console.log('FFmpeg download and extraction command executed.');

      const filesInBin = fs.readdirSync(BIN_DIR);
      const extractedDirName = filesInBin.find((f: string) =>
        FFMPEG_EXPECTED_EXTRACTED_DIR_PATTERN.test(f) &&
        fs.statSync(path.join(BIN_DIR, f)).isDirectory()
      );

      if (extractedDirName) {
        const extractedDirPath = path.join(BIN_DIR, extractedDirName);
        const ffmpegSourcePath = path.join(extractedDirPath, FFMPEG_EXE_NAME);
        const ffprobeSourcePath = path.join(extractedDirPath, FFPROBE_EXE_NAME); 

        if (fs.existsSync(ffmpegSourcePath)) {
          fs.renameSync(ffmpegSourcePath, FFMPEG_FINAL_PATH);
          fs.chmodSync(FFMPEG_FINAL_PATH, '755');
          console.log(`ffmpeg moved to ${FFMPEG_FINAL_PATH} and made executable.`);
        } else {
          console.error(`Could not find ${FFMPEG_EXE_NAME} in ${extractedDirPath}. Manual check needed.`);
        }

        if (fs.existsSync(ffprobeSourcePath)) {
          fs.renameSync(ffprobeSourcePath, FFPROBE_FINAL_PATH);
          fs.chmodSync(FFPROBE_FINAL_PATH, '755');
          console.log(`ffprobe moved to ${FFPROBE_FINAL_PATH} and made executable.`);
        } else {
          console.warn(`ffprobe not found in ${extractedDirPath}. This is optional but recommended.`);
        }

        fs.rmSync(extractedDirPath, { recursive: true, force: true });
        console.log(`Cleaned up temporary directory: ${extractedDirPath}`);

      } else {
        console.error(`Could not automatically find the extracted FFmpeg directory in ${BIN_DIR}.`);
        console.error('Please check the bin/ directory. You might need to manually move ffmpeg to bin/ffmpeg.');
      }
    } catch (error: any) {
      console.error('Error during FFmpeg setup using shell command:', error.message);
      console.error('Please ensure wget, xz, and tar are installed and in your PATH.');
      console.error('Alternatively, download and place ffmpeg (and ffprobe) manually in the bin/ directory.');
    }
  } else {
    console.log('ffmpeg already exists at:', FFMPEG_FINAL_PATH);
    if (fs.existsSync(FFPROBE_FINAL_PATH)) {
        console.log('ffprobe already exists at:', FFPROBE_FINAL_PATH);
    }
  }
  console.log('--- Binary setup complete ---');
  process.exit(0);
}

setupBinaries().catch((error: Error) => {
  console.error("Failed to setup binaries:", error);
  process.exit(1); 
});

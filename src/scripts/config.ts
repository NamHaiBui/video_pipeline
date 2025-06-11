import dotenv from 'dotenv';
dotenv.config();

export interface Config {
  // Server configuration
  port: number;
  host: string;
  
  // Video processing configuration
  videoInputDir: string;
  videoOutputDir: string;
  tempDir: string;
  
  // Quality settings
  defaultVideoQuality: string;
  supportedFormats: string[];
  
  // External services
  ffmpegPath?: string;
  yt_dlpPath?:string;
  
  // Environment
  nodeEnv: string;
  logLevel: string;
}

const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || 'localhost',
  
  videoInputDir: process.env.VIDEO_INPUT_DIR || './input',
  videoOutputDir: process.env.VIDEO_OUTPUT_DIR || './output',
  tempDir: process.env.TEMP_DIR || './temp',
  
  defaultVideoQuality: process.env.DEFAULT_VIDEO_QUALITY || '720p',
  supportedFormats: process.env.SUPPORTED_FORMATS?.split(',') || ['mp4', 'avi', 'mov', 'mkv'],
  
  ffmpegPath: process.env.FFMPEG_PATH,
  yt_dlpPath: process.env.YT_DLP_PATH || 'yt-dlp',
  
  
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info'
};

export default config;
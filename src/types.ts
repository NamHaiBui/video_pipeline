export interface VideoMetadata {
  title: string;
  uploader: string;
  id: string;
  duration: number;
  description: string;
  upload_date: string;
  view_count: number;
  like_count?: number;
  dislike_count?: number;
  average_rating?: number;
  age_limit: number;
  webpage_url: string;
  extractor: string;
  extractor_key: string;
  thumbnail: string;
  thumbnails: Array<{
    url: string;
    id: string;
    width?: number;
    height?: number;
  }>;
  formats: Array<{
    format_id: string;
    url: string;
    ext: string;
    format: string;
    format_note?: string;
    width?: number;
    height?: number;
    fps?: number;
    acodec?: string;
    vcodec?: string;
    abr?: number;
    vbr?: number;
    filesize?: number;
    filesize_approx?: number;
  }>;
  [key: string]: any; 
}

export interface ProgressInfo {
  percent: string;
  eta: string;
  speed: string;
  total?: string;
  raw: string;
}

export interface DownloadOptions {
  outputDir?: string;
  outputFilename?: string;
  format?: string;
  onProgress?: (progress: ProgressInfo) => void;
  clientType?: string;
  cookiesFile?: string;
  poToken?: string;
  userAgent?: string;
  additionalHeaders?: string[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface DownloadJob {
  id: string;
  url: string;
  status: 'pending' | 'downloading_metadata'| 'downloading' | 'completed' | 'error';
  progress: {
    video?: ProgressInfo;
    audio?: ProgressInfo;
  };
  metadata?: VideoMetadata;
  filePaths?: {
    videoPath?: string;
    audioPath?: string;
    metadataPath?: string;
  };
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface DownloadRequest {
  url: string;
}

export interface DownloadResponse {
  success: boolean;
  jobId: string;
  message: string;
}

export interface JobStatusResponse {
  success: boolean;
  job?: DownloadJob;
  message: string;
}

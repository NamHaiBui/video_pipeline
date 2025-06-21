# Podcast Processing Pipeline - TypeScript

A comprehensive podcast processing pipeline built with TypeScript and Node.js that converts YouTube videos into podcast episodes with automatic audio extraction, metadata processing, and cloud storage integration.

## Features

- 🎙️ **YouTube to Podcast Conversion**: Automatically process YouTube videos as podcast episodes
- 🎧 **High-Quality Audio Extraction**: Extract podcast-optimized audio in MP3, AAC, or Opus formats
- ☁️ **AWS Cloud Integration**: Upload to S3 buckets with organized folder structure
- 🗄️ **DynamoDB Storage**: Store podcast episode metadata and processing status
- 📊 **Real-time Progress Tracking**: Monitor processing jobs with detailed progress updates
- 🔍 **Content Analysis**: AI-powered content categorization and guest detection
- 📋 **Podcast Metadata**: Automatic generation of podcast-standard metadata
- 🌊 **SQS Queue Processing**: Scalable job processing with AWS SQS integration

## Installation

```bash
npm install
```

This will automatically download the required binaries (yt-dlp and ffmpeg).

## Usage

### Development Mode (TypeScript)

```bash
npm run dev
```

### Production Mode (Compiled JavaScript)

```bash
npm start
```

### SQS Integration

The server includes integrated SQS polling that automatically processes jobs from an AWS SQS queue:

```bash
# Start the server with SQS polling enabled (enabled by default in docker-compose)
ENABLE_SQS_POLLING=true npm run server
```

See [ECS_DEPLOYMENT_GUIDE.md](ECS_DEPLOYMENT_GUIDE.md) for detailed AWS ECS deployment instructions.

### Manual Binary Setup

```bash
npm run setup
```

## Scripts

### Main Scripts
- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Run TypeScript directly with tsx
- `npm start` - Build and run the compiled JavaScript
- `npm run setup` - Download required binaries
- `npm run clean` - Remove compiled output

### Test Scripts
- `npm run test:metadata-only` - Test metadata extraction only
- `npm run test:slug-filename` - Test filename slug generation
- `npm run test:slug-integration` - Test complete slug integration
- `npm run test:complete-slug` - Test complete slug functionality
- `npm run test:video-slug` - Test video slug generation
- `npm run test:trimming-queue` - Test video trimming queue functionality

## TypeScript Features

### Type Definitions

The project includes comprehensive type definitions for:

- `VideoMetadata` - Complete video information from yt-dlp
- `ProgressInfo` - Download progress tracking
- `DownloadOptions` - Configuration options for downloads
- `CommandResult` - Command execution results

### Example Usage

```typescript
import { getVideoMetadata, downloadAndMergeVideo } from './lib/ytdlpWrapper.js';
import { ProgressInfo } from './types.js';

// Get video metadata with full type safety
const metadata = await getVideoMetadata('https://youtube.com/watch?v=...');
console.log(metadata.title, metadata.uploader);

// Download video with audio merged
await downloadAndMergeVideo('https://youtube.com/watch?v=...', {
  outputFilename: 'Custom - %(title)s.mp4',
  onProgress: (progress: ProgressInfo) => {
    console.log(`Progress: ${progress.percent} - ${progress.raw}`);
  }
});
```

## Project Structure

```
src/
├── index.ts                 # Main application entry point
├── types.ts                 # TypeScript type definitions
├── lib/
│   └── ytdlpWrapper.ts     # yt-dlp wrapper with types
└── scripts/
    └── setup_binaries.ts   # Binary download script

dist/                       # Compiled JavaScript output
bin/                        # Downloaded binaries (yt-dlp, ffmpeg)
downloads/                  # Downloaded videos
```

## Migration from JavaScript

This project has been fully converted from JavaScript to TypeScript, providing:

- **Type Safety**: Catch errors at compile time
- **Better IDE Support**: IntelliSense, auto-completion, and refactoring
- **Maintainability**: Clear interfaces and contracts
- **Documentation**: Types serve as living documentation

## Dependencies

- **Runtime**: `axios`, `progress`
- **Development**: `typescript`, `tsx`, `@types/node`, `@types/progress`

## Configuration

### Environment Variables

The pipeline supports various environment variables for configuration:

#### AWS Services

- `AWS_REGION`: AWS region for services (default: us-east-1)
- `AWS_ACCESS_KEY_ID`: AWS access key for authentication
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for authentication

#### S3 Configuration

- `S3_UPLOAD_ENABLED`: Enable S3 uploads (true/false)
- `AUDIO_BUCKET_NAME`: S3 bucket for audio files
- `VIDEO_BUCKET_NAME`: S3 bucket for video files

#### DynamoDB Configuration

- `DYNAMODB_PODCAST_EPISODES_TABLE`: Table name for podcast episodes (default: PodcastEpisodeStoreTest)

#### SQS Configuration

- `SQS_QUEUE_URL`: URL for the main processing queue
- `VIDEO_TRIMMING_QUEUE_URL`: URL for the video trimming queue (triggered when processing is complete)
- `ENABLE_SQS_POLLING`: Enable/disable SQS polling (default: true)
- `SQS_MAX_MESSAGES`: Maximum messages to receive per poll (default: 10)
- `SQS_WAIT_TIME`: Long polling wait time in seconds (default: 20)

#### Video Trimming Integration

- When podcast processing is complete (both `quotes_audio_status` and `chunking_status` are "COMPLETED"), the system automatically queues a message to the video trimming SQS queue specified by `VIDEO_TRIMMING_QUEUE_URL`
- Default queue: `https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming`
- Message format: `{"id": "episode-id"}`

#### Other Configuration

- `PORT`: Server port (default: 3000)
- `YOUTUBE_API_KEY`: YouTube Data API key for search functionality
- `PREFERRED_AUDIO_FORMAT`: Audio format preference (mp3/aac/opus, default: mp3)
- `YTDLP_USE_NIGHTLY`: Use nightly builds of yt-dlp (true/false)
- `PODCAST_CONVERSION_ENABLED`: Enable podcast conversion features (default: true)

## TypeScript API

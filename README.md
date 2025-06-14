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
- 🧪 **LocalStack Support**: Full local development environment with AWS emulation

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

### LocalStack Testing (AWS S3 Simulation)

```bash
# Quick start with LocalStack
npm run test:localstack

# Or step-by-step:
npm run localstack:init    # Start LocalStack and create S3 buckets
npm run localstack:test    # Test S3 connectivity
npm run server:localstack  # Start server with LocalStack config
```

See [LOCALSTACK-TESTING.md](LOCALSTACK-TESTING.md) for detailed LocalStack setup and testing instructions.

### SQS Integration

The server includes integrated SQS polling that automatically processes jobs from an AWS SQS queue:

```bash
# Start the server with SQS polling enabled (enabled by default in docker-compose)
ENABLE_SQS_POLLING=true npm run server

# Test SQS integration with LocalStack
npm run test:job-queue

# Start the server with LocalStack and SQS polling
npm run server:sqs:localstack
```

See [INTEGRATED-SQS.md](docs/INTEGRATED-SQS.md) for detailed setup and configuration instructions.

### Manual Binary Setup

```bash
npm run setup
```

## Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm run dev` - Run TypeScript directly with tsx
- `npm start` - Build and run the compiled JavaScript
- `npm run setup` - Download required binaries
- `npm run clean` - Remove compiled output

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

## License

ISC

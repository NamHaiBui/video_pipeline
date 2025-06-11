# Video Pipeline - TypeScript

A portable Node.js application that wraps yt-dlp and ffmpeg for video downloading and processing, now fully converted to TypeScript.

## Features

- **TypeScript**: Full type safety and better development experience
- **Video Metadata Extraction**: Get detailed information about videos
- **Progressive Downloads**: Download videos with real-time progress tracking
- **Portable Binaries**: Automatically downloads and manages yt-dlp and ffmpeg binaries
- **Type Definitions**: Complete type definitions for all video metadata and API responses

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
import { getVideoMetadata, downloadVideoWithProgress } from './lib/ytdlpWrapper.js';
import { ProgressInfo } from './types.js';

// Get video metadata with full type safety
const metadata = await getVideoMetadata('https://youtube.com/watch?v=...');
console.log(metadata.title, metadata.uploader);

// Download with progress callback
await downloadVideoWithProgress('https://youtube.com/watch?v=...', {
  outputFilename: 'Custom - %(title)s.%(ext)s',
  onProgress: (progress: ProgressInfo) => {
    console.log(`Progress: ${progress.percent}`);
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

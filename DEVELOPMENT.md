# Video Pipeline Development Guide

## Overview

This guide covers setting up and developing the Video Pipeline application locally.

## Prerequisites

- Node.js 20+ 
- Docker and Docker Compose
- AWS CLI (for production deployment)
- Git

## Local Development Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd video_pipeline
npm install
```

### 2. Environment Configuration

```bash
# Copy the environment template
cp .env.example .env

# Edit the .env file with your configuration
nano .env
```

### 3. Development with LocalStack (Optional)

For local AWS service emulation:

```bash
# Start LocalStack development environment
docker-compose -f docker-compose.local.yml up -d

# Initialize LocalStack resources
./scripts/init-localstack.sh
```

### 4. Direct Development

For development without Docker:

```bash
# Start the development server
npm run dev

# Or start with SQS polling enabled
ENABLE_SQS_POLLING=true npm run dev
```

## Development Scripts

```bash
# Development
npm run dev                    # Start TypeScript development server
npm run build                  # Compile TypeScript to JavaScript
npm run start                  # Build and run compiled JavaScript

# Testing
npm run test:metadata-only     # Test metadata extraction only
npm run test:slug-filename     # Test filename slug generation
npm run test:slug-integration  # Test complete slug integration
npm run test:complete-slug     # Test complete slug functionality
npm run test:video-slug        # Test video slug generation
npm run test:trimming-queue    # Test video trimming queue functionality

# Utilities
npm run setup                  # Download required binaries
npm run clean                  # Clean build artifacts
npm run update-ytdlp           # Update yt-dlp binary
npm run update-ytdlp:nightly   # Update to nightly build
```

## Docker Development

### Local Development with Docker

```bash
# Start development environment
./docker-helper.sh dev

# View logs
./docker-helper.sh logs-dev

# Stop development environment
./docker-helper.sh stop
```

### Production Testing

```bash
# Build production image
./docker-helper.sh build-prod

# Test production configuration
./docker-helper.sh prod

# Validate containerization
./validate-containers.sh
```

## Architecture

### Application Structure

```
src/
├── server.ts              # Main Express server
├── types.ts              # TypeScript type definitions
├── constants.ts          # Application constants
├── lib/
│   ├── ytdlpWrapper.ts   # YouTube download wrapper
│   ├── s3Service.ts      # AWS S3 integration
│   ├── dynamoService.ts  # AWS DynamoDB integration
│   ├── sqsService.ts     # AWS SQS integration
│   ├── logger.ts         # Logging service
│   ├── config.ts         # Configuration management
│   └── utils/
│       └── utils.ts      # Utility functions
└── scripts/              # Testing and utility scripts
```

### Key Components

1. **ytdlpWrapper.ts**: Handles YouTube video downloading and processing
2. **server.ts**: Express server with REST API endpoints
3. **sqsPoller.ts**: SQS message processing for scalable job handling
4. **AWS Services**: S3 for storage, DynamoDB for metadata, SQS for job queues

## API Endpoints

### Core Endpoints

```bash
# Health check
GET /health

# Start video processing
POST /api/download
{
  "url": "https://youtube.com/watch?v=..."
}

# Check job status
GET /api/job/:jobId

# List all jobs
GET /api/jobs

# Delete job
DELETE /api/job/:jobId

# Search YouTube videos
GET /api/search/:query?maxResults=10

# Update yt-dlp
POST /api/update-ytdlp
{
  "nightly": false,
  "force": false
}

# Get update status
GET /api/update-status
```

### Response Formats

```typescript
// Download Response
{
  "success": true,
  "jobId": "uuid-string",
  "message": "Download job started successfully"
}

// Job Status Response
{
  "success": true,
  "job": {
    "id": "job-id",
    "url": "youtube-url", 
    "status": "completed",
    "progress": {...},
    "metadata": {...},
    "filePaths": {...}
  }
}
```

## Environment Variables

### Required for Development

```bash
# Application
PORT=3000
NODE_ENV=development

# AWS Configuration (for production features)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# S3 Configuration
S3_UPLOAD_ENABLED=true
S3_AUDIO_BUCKET_NAME=your-audio-bucket
S3_VIDEO_BUCKET_NAME=your-video-bucket

# DynamoDB Configuration
DYNAMODB_PODCAST_EPISODES_TABLE=PodcastEpisodeStore

# SQS Configuration
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/your-queue
VIDEO_TRIMMING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming

# External APIs
YOUTUBE_API_KEY=your-youtube-api-key
```

### Optional Configuration

```bash
# Feature Toggles
ENABLE_SQS_POLLING=true
PODCAST_CONVERSION_ENABLED=true

# Processing Configuration
MAX_CONCURRENT_JOBS=2
PREFERRED_AUDIO_FORMAT=mp3
DEFAULT_VIDEO_QUALITY=720p

# yt-dlp Configuration
YTDLP_USE_NIGHTLY=false
```

## Testing

### Unit Testing

```bash
# Test metadata extraction
npm run test:metadata-only https://youtube.com/watch?v=example

# Test slug generation
npm run test:slug-filename

# Test video trimming queue
npm run test:trimming-queue episode-id-123
```

### Integration Testing

```bash
# Test complete workflow
npm run test:complete-slug https://youtube.com/watch?v=example

# Test video processing
npm run test:video-slug https://youtube.com/watch?v=example
```

### Container Testing

```bash
# Validate Docker setup
./validate-containers.sh

# Test with specific configuration
./validate-containers.sh build
```

## Debugging

### Application Logs

```bash
# View application logs
tail -f logs/app.log

# View Docker logs
docker-compose -f docker-compose.local.yml logs -f video-pipeline
```

### Common Issues

1. **Binary Download Issues**
   ```bash
   npm run setup
   ```

2. **AWS Permission Issues**
   - Check AWS credentials and permissions
   - Verify IAM roles and policies

3. **YouTube Download Failures**
   - Update yt-dlp: `npm run update-ytdlp`
   - Check for geo-restrictions or age-gated content

4. **Container Issues**
   ```bash
   ./docker-helper.sh logs-dev
   ```

## Code Style

### TypeScript Guidelines

- Use strict TypeScript configuration
- Define interfaces for all data structures
- Use proper error handling with try/catch
- Implement comprehensive logging

### Project Conventions

- Use kebab-case for file names
- Use camelCase for function and variable names
- Use PascalCase for interfaces and classes
- Add JSDoc comments for public functions

## Deployment

### Local Testing

```bash
# Test production build locally
npm run build
npm start
```

### Production Deployment

See [ECS_DEPLOYMENT_GUIDE.md](ECS_DEPLOYMENT_GUIDE.md) for production deployment instructions.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## Troubleshooting

### Performance Issues

- Check container resource limits
- Monitor CloudWatch metrics
- Optimize concurrent job settings

### Network Issues

- Verify Docker network configuration
- Check firewall settings
- Ensure proper port mapping

### Storage Issues

- Check available disk space
- Verify S3 bucket permissions
- Monitor EFS usage (in ECS)
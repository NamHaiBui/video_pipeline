# Performance Improvements Summary

## CPU Utilization Enhancements

This document summarizes the CPU utilization and concurrency improvements made to the video processing pipeline.

## Changes Made

### 1. CPU-Aware yt-dlp Connections
**Before:**
- Fixed to 4 parallel connections
- Did not scale with available CPU resources

**After:**
- Automatically scales with CPU core count
- Uses all available CPU cores by default
- Configurable via `YTDLP_CONNECTIONS` environment variable

### 2. Enhanced FFmpeg Threading
**Before:**
- Limited threading in some operations
- Merge operations didn't specify thread count

**After:**
- All FFmpeg operations use maximum available threads
- Merge operations explicitly use all CPU cores
- Improved HLS rendering thread allocation

### 3. S3 Throughput Optimization
**Before:**
- 16MB upload parts
- Fixed queue size of 8
- 16MB download parts

**After:**
- 32MB upload parts (doubled for better throughput)
- Queue size scales with I/O concurrency (up to 16)
- 32MB download parts (doubled for better throughput)
- CPU-aware concurrency scaling

### 4. Improved HLS Video Rendering
**Before:**
- Simple thread division: `cores / renditions`
- Could result in single-threaded encoders

**After:**
- Intelligent thread allocation with minimum guarantees
- Each encoder gets at least 2 threads
- Single jobs can use up to half the CPU cores per encoder
- Better resource utilization for both single and multiple jobs

### 5. Enhanced Monitoring and Configuration
**Added:**
- CPU configuration logging on startup
- Comprehensive documentation
- Test script for validation
- Auto-detection of container CPU limits

## Performance Impact

### Single Job Scenarios
- **yt-dlp downloads**: Now use all CPU cores instead of just 4
- **FFmpeg processing**: Full CPU utilization across all operations
- **S3 operations**: Larger chunks and better concurrency
- **Video rendering**: Optimal thread allocation per encoder

### Multiple Job Scenarios
- **Better resource sharing**: Each job gets fair CPU allocation
- **Improved I/O throughput**: Higher concurrency for S3 and HTTP operations
- **Balanced processing**: Thread allocation optimized for concurrent workloads

## Environment Variables for Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `YTDLP_CONNECTIONS` | CPU cores | yt-dlp parallel connections |
| `FFMPEG_THREADS` | CPU cores | FFmpeg thread count |
| `MAX_CONCURRENT_JOBS` | CPU cores | Maximum simultaneous jobs |
| `S3_UPLOAD_PART_SIZE_MB` | 32 | S3 upload chunk size |
| `S3_UPLOAD_QUEUE_SIZE` | I/O concurrency | S3 upload queue depth |
| `S3_DOWNLOAD_PART_SIZE_MB` | 32 | S3 download chunk size |
| `S3_UPLOAD_CONCURRENCY` | CPU cores × 2 | S3 upload operations |
| `S3_DOWNLOAD_CONCURRENCY` | CPU cores × 2 | S3 download operations |

## Expected Performance Gains

### For 4-core systems:
- **yt-dlp downloads**: Same (already using 4 connections)
- **FFmpeg processing**: Up to 4x improvement for operations that weren't using threading
- **S3 uploads**: 2x larger chunks + better concurrency = significant throughput improvement
- **HLS rendering**: Better thread allocation = more efficient CPU usage

### For 8+ core systems:
- **yt-dlp downloads**: 2x+ improvement (was capped at 4, now uses all cores)
- **FFmpeg processing**: Scales linearly with core count
- **S3 operations**: Scales with I/O capacity (2x core count)
- **Overall throughput**: Significantly improved for CPU-intensive workloads

## Container Environments

The system automatically detects container CPU limits using cgroups v2, ensuring optimal resource utilization in:
- Docker containers
- Kubernetes pods
- ECS tasks
- Other containerized environments

## Testing and Validation

Use the provided test script to validate configuration:
```bash
npx tsx scripts/test-cpu-utilization.ts
```

This will show the actual CPU detection and configuration being used in your environment.
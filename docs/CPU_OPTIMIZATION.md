# CPU Utilization and Concurrency Configuration

This document describes the CPU optimization settings and environment variables that control resource utilization in the video processing pipeline.

## CPU-Aware Configurations

### yt-dlp Parallel Connections
- **Environment Variable**: `YTDLP_CONNECTIONS`
- **Default**: Number of CPU cores available
- **Description**: Controls the number of parallel connections yt-dlp uses for downloading. Automatically scales with CPU capacity.

### FFmpeg Threading
- **Environment Variable**: `FFMPEG_THREADS`
- **Default**: Number of CPU cores available
- **Description**: Sets the number of threads FFmpeg uses for video processing operations.

### Global Concurrency Controls
- **Environment Variable**: `MAX_CONCURRENT_JOBS`
- **Default**: Number of CPU cores available
- **Description**: Maximum number of jobs that can run simultaneously.

- **Environment Variable**: `SEMAPHORE_MAX_CONCURRENCY`
- **Default**: Auto-detected based on operation type
- **Description**: Global override for all semaphore concurrency limits.

### Subsystem-Specific Concurrency
- **Environment Variable**: `S3_UPLOAD_CONCURRENCY`
- **Default**: CPU cores × 2 (I/O multiplier)
- **Description**: Concurrent S3 upload operations.

- **Environment Variable**: `S3_DOWNLOAD_CONCURRENCY`
- **Default**: CPU cores × 2 (I/O multiplier)
- **Description**: Concurrent S3 download operations.

- **Environment Variable**: `HTTP_CONCURRENCY`
- **Default**: CPU cores × 2 (I/O multiplier)
- **Description**: Concurrent HTTP operations.

- **Environment Variable**: `DISK_CONCURRENCY`
- **Default**: Number of CPU cores
- **Description**: Concurrent disk I/O operations.

- **Environment Variable**: `DB_MAX_INFLIGHT`
- **Default**: Max(2, CPU cores)
- **Description**: Maximum concurrent database operations.

### S3 Upload/Download Optimization
- **Environment Variable**: `S3_UPLOAD_PART_SIZE_MB`
- **Default**: 32 MB (increased from 16 MB)
- **Description**: Size of each multipart upload chunk.

- **Environment Variable**: `S3_UPLOAD_QUEUE_SIZE`
- **Default**: Min(I/O concurrency, 16)
- **Description**: Number of upload parts queued simultaneously.

- **Environment Variable**: `S3_DOWNLOAD_PART_SIZE_MB`
- **Default**: 32 MB (increased from 16 MB)
- **Description**: Size of each download chunk for ranged downloads.

## HLS Video Rendering Optimization

The system automatically optimizes thread allocation for video rendering:

1. **Single Job Scenario**: Each encoder gets more threads (up to half of available CPU cores)
2. **Multiple Jobs**: Threads are balanced across all renditions
3. **Minimum Threads**: Each encoder gets at least 2 threads for stability

## Auto-Detection Features

### CPU Detection
- Automatically detects container CPU limits (cgroups v2)
- Falls back to physical CPU count if no limits detected
- Ensures optimal resource utilization in containerized environments

### Operation Type Scaling
- **CPU-bound operations**: Scale 1:1 with CPU cores
- **I/O-bound operations**: Scale 2:1 with CPU cores for better throughput

## Performance Tuning Tips

1. **For Single Jobs**: The system automatically allocates maximum resources when only one job is running
2. **For High-Throughput**: Increase `MAX_CONCURRENT_JOBS` if you have sufficient memory and bandwidth
3. **For Large Files**: Increase `S3_UPLOAD_PART_SIZE_MB` and `S3_DOWNLOAD_PART_SIZE_MB`
4. **For Bandwidth-Limited Environments**: Reduce `S3_UPLOAD_CONCURRENCY` and `S3_DOWNLOAD_CONCURRENCY`

## Monitoring

All operations provide metrics for monitoring:
- Job queue depth
- Operations in flight
- Success/failure counters
- Latency measurements

Use these metrics to tune the configuration for your specific environment and workload.
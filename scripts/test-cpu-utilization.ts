#!/usr/bin/env tsx

/**
 * CPU Utilization Test Script
 * 
 * This script demonstrates the CPU-aware configurations in the video processing pipeline.
 * It shows how the system automatically detects and utilizes available CPU resources.
 */

import { computeDefaultConcurrency, logCpuConfiguration } from '../src/lib/utils/concurrency.js';
import { logger } from '../src/lib/utils/logger.js';

console.log('🧪 CPU Utilization Test');
console.log('='.repeat(50));

// Log the current CPU configuration
logCpuConfiguration();

console.log('\n📋 Configuration Summary:');
console.log('='.repeat(30));

// Test different concurrency computations
const cpuConcurrency = computeDefaultConcurrency('cpu');
const ioConcurrency = computeDefaultConcurrency('io');

console.log(`CPU-bound operations will use: ${cpuConcurrency} concurrent workers`);
console.log(`I/O-bound operations will use: ${ioConcurrency} concurrent workers`);

// Show what this means for various operations
console.log('\n🔧 Operation-Specific Settings:');
console.log('='.repeat(35));

console.log(`yt-dlp download connections: ${process.env.YTDLP_CONNECTIONS || cpuConcurrency}`);
console.log(`FFmpeg encoding threads: ${process.env.FFMPEG_THREADS || cpuConcurrency}`);
console.log(`S3 upload part size: ${process.env.S3_UPLOAD_PART_SIZE_MB || '32'} MB`);
console.log(`S3 upload queue size: ${process.env.S3_UPLOAD_QUEUE_SIZE || Math.min(ioConcurrency, 16)}`);
console.log(`Maximum concurrent jobs: ${process.env.MAX_CONCURRENT_JOBS || cpuConcurrency}`);

console.log('\n✅ All systems configured for maximum CPU utilization!');
console.log('💡 Tip: Set environment variables to override auto-detected values');

export {};
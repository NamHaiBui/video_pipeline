import { Message } from '@aws-sdk/client-sqs';
import { createSQSServiceFromEnv } from './lib/sqsService.js';
import { logger } from './lib/utils/logger.js';
import { SQSJobMessage } from './types.js';
import { processDownload, downloadVideoForExistingEpisode } from './server.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

// Configuration
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '30000', 10);
const WORKER_ID = `${os.hostname()}-${process.pid}`;

// Create SQS service
const sqsService = createSQSServiceFromEnv();

// Active jobs tracking
class JobTracker {
  private active: Map<string, {
    jobId: string;
    startTime: Date;
  }> = new Map();
  private maxConcurrent: number;
  
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    logger.info(`Job tracker initialized with max ${maxConcurrent} concurrent jobs`);
  }
  
  /**
   * Start tracking a job
   */
  startJob(jobId: string): boolean {
    if (this.active.size >= this.maxConcurrent) {
      return false;
    }
    
    this.active.set(jobId, {
      jobId,
      startTime: new Date()
    });
    
    logger.info(`Job ${jobId} started. Active jobs: ${this.active.size}/${this.maxConcurrent}`);
    return true;
  }
  
  /**
   * Mark a job as completed
   */
  completeJob(jobId: string): void {
    if (this.active.has(jobId)) {
      const job = this.active.get(jobId);
      const duration = job ? new Date().getTime() - job.startTime.getTime() : 0;
      this.active.delete(jobId);
      logger.info(`Job ${jobId} completed in ${Math.round(duration / 1000)}s. Active jobs: ${this.active.size}/${this.maxConcurrent}`);
    }
  }
  
  /**
   * Check if more jobs can be accepted
   */
  canAcceptMoreJobs(): boolean {
    return this.active.size < this.maxConcurrent;
  }
  
  /**
   * Get count of active jobs
   */
  get count(): number {
    return this.active.size;
  }
  
  /**
   * Get all active job IDs
   */
  get activeJobIds(): string[] {
    return Array.from(this.active.keys());
  }
}

// Create job tracker
const jobTracker = new JobTracker(MAX_CONCURRENT_JOBS);

/**
 * Move a failed SQS message to the Dead Letter Queue (DLQ)
 */
async function moveToDLQ(message: Message): Promise<void> {
  if (!sqsService || !process.env.SQS_DLQ_URL || !message.Body) {
    logger.error('DLQ move failed: SQS service, DLQ URL, or message body missing');
    return;
  }
  try {
    await sqsService.sendMessage(process.env.SQS_DLQ_URL, { Body: message.Body });
    logger.info('Moved failed message to DLQ');
    // Delete from main queue after moving to DLQ
    if (message.ReceiptHandle) {
      await sqsService.deleteMessage(message.ReceiptHandle);
    }
  } catch (err: any) {
    logger.error('Failed to move message to DLQ:', err);
  }
}


/**
 * Process an SQS message
 */
async function handleSQSMessage(message: Message): Promise<boolean> {
  if (!message.Body || !message.ReceiptHandle) {
    logger.warn('Received invalid SQS message (no body or receipt handle)');
    return false;
  }
  
  try {
    // Parse message
    const messageId = message.MessageId || 'unknown';
    const jobData = JSON.parse(message.Body) as SQSJobMessage;
    
    // Determine message type based on structure
    const isVideoEnrichment = !!(jobData.id && jobData.url && !jobData.videoId);
    const isNewEntry = !!(jobData.videoId && jobData.episodeTitle && jobData.originalUri);
    
    // Validate message structure
    if (isVideoEnrichment) {
      // Video Enrichment: {"id": str, "url": str}
      if (!jobData.id || !jobData.url) {
        logger.warn(`Invalid video enrichment message ${messageId}: missing id or url`);
        return true; // Delete invalid messages
      }
    } else if (isNewEntry) {
      // New Entry: comprehensive video metadata
      if (!jobData.videoId || !jobData.episodeTitle || !jobData.originalUri) {
        logger.warn(`Invalid new entry message ${messageId}: missing required fields (videoId, episodeTitle, originalUri)`);
        return true; // Delete invalid messages
      }
    } else {
      // Legacy format validation
      if (!jobData.url) {
        logger.warn(`Invalid job data in message ${messageId}: missing url or unknown message format`);
        return true; // Delete invalid messages
      }
    }
    
    // Handle video enrichment (existing episode video download)
    if (isVideoEnrichment) {
      logger.info(`Processing video enrichment: ${jobData.id} - ${jobData.url}`);
      
      // Check if we can accept more jobs
      if (!jobTracker.canAcceptMoreJobs()) {
        logger.debug(`Cannot accept video enrichment job ${jobData.id}, max concurrent jobs reached`);
        return false; // Keep in queue
      }
      
      // Start job tracking
      const trackingJobId = `enrichment-${jobData.id}`;
      if (!jobTracker.startJob(trackingJobId)) {
        return false; // Failed to start job, try again later
      }
      
      // Process video enrichment job async
      downloadVideoForExistingEpisode(jobData.id!, jobData.url!)
        .then(() => {
          logger.info(`Video enrichment ${jobData.id} completed successfully`);
          jobTracker.completeJob(trackingJobId);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        })
        .catch(async error => {
          logger.error(`Error processing video enrichment job ${jobData.id}: ${error.message}`, undefined, { error });
          jobTracker.completeJob(trackingJobId);
          await moveToDLQ(message);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        });
      
      // Delete message from queue since we've accepted the job
      if (sqsService) {
        await sqsService.deleteMessage(message.ReceiptHandle);
      }
      
      return true;
    }
    
    // Handle new entry creation
    if (isNewEntry) {
      // Generate jobId for tracking
      const generatedJobId = jobData.videoId || messageId || uuidv4();
      logger.info(`Processing new entry creation: ${generatedJobId} - ${jobData.episodeTitle}`);
      
      // Check if we can accept more jobs
      if (!jobTracker.canAcceptMoreJobs()) {
        logger.debug(`Cannot accept new entry job ${generatedJobId}, max concurrent jobs reached`);
        return false; // Keep in queue
      }
      
      // Start job tracking
      const trackingJobId = `newentry-${generatedJobId}`;
      if (!jobTracker.startJob(trackingJobId)) {
        return false; // Failed to start job, try again later
      }
      
      // Process new entry job async - pass the full jobData with new entry structure
      processDownload(generatedJobId, jobData.originalUri!, jobData)
        .then(() => {
          logger.info(`New entry creation ${generatedJobId} completed successfully`);
          jobTracker.completeJob(trackingJobId);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        })
        .catch(async error => {
          logger.error(`Error processing new entry job ${generatedJobId}: ${error.message}`, undefined, { error });
          jobTracker.completeJob(trackingJobId);
          await moveToDLQ(message);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        });
      
      // Delete message from queue since we've accepted the job
      if (sqsService) {
        await sqsService.deleteMessage(message.ReceiptHandle);
      }
      
      return true;
    }
    // Handle legacy message format (for backward compatibility)
    // Validate that url is present for legacy messages
    if (!jobData.url) {
      logger.warn(`Invalid legacy job data in message ${messageId}: missing url`);
      return true; // Delete invalid messages
    }
    
    // Ensure that jobId is always defined for legacy downloads
    if (!jobData.jobId || jobData.jobId.trim() === '') {
      // Try to use messageId first, fallback to generating a new UUID
      const generatedJobId = messageId && messageId !== 'unknown' ? messageId : uuidv4();
      logger.info(`Legacy message ${messageId} has no jobId, generating: ${generatedJobId}`);
      jobData.jobId = generatedJobId;
    } else {
      jobData.jobId = jobData.jobId.trim();
    }
    
    // At this point jobId should always be defined and non-empty
    const channelInfo = jobData.channelId ? ` [Channel: ${jobData.channelId}]` : '';
    logger.debug(`Processing legacy download job: ${jobData.jobId} - ${jobData.url}${channelInfo}`);
    
    // Check if we can accept more jobs
    if (!jobTracker.canAcceptMoreJobs()) {
      logger.debug(`Cannot accept legacy job ${jobData.jobId}, max concurrent jobs reached`);
      return false; // Keep in queue
    }
    
    // Start job
    if (!jobTracker.startJob(jobData.jobId)) {
      return false; // Failed to start job, try again later
    }
    
    // Process legacy job async - pass the full jobData instead of just channelId
    processDownload(jobData.jobId, jobData.url, jobData)
      .then(() => {
        logger.info(`Legacy job ${jobData.jobId} completed successfully`);
        jobTracker.completeJob(jobData.jobId!);
        if (jobTracker.canAcceptMoreJobs()) {
          pollSQSMessages();
        }
      })
      .catch(async error => {
        logger.error(`Error processing legacy job ${jobData.jobId}: ${error.message}`, undefined, { error });
        jobTracker.completeJob(jobData.jobId!);
        await moveToDLQ(message);
        if (jobTracker.canAcceptMoreJobs()) {
          pollSQSMessages();
        }
      });
    
    // Delete message from queue since we've accepted the job
    if (sqsService) {
      await sqsService.deleteMessage(message.ReceiptHandle);
    }
    
    return true;
  } catch (error: any) {
    logger.error(`Error handling SQS message: ${error.message}`, undefined, { error });
    await moveToDLQ(message);
    return true; // Keep in queue
  }
}

/**
 * Poll SQS for messages
 */
async function pollSQSMessages(): Promise<void> {
  if (!sqsService) {
    logger.debug('SQS service not configured, skipping poll');
    return;
  }
  
  // Only poll if we can accept more jobs
  if (!jobTracker.canAcceptMoreJobs()) {
    logger.debug(`Not polling SQS - at max capacity (${jobTracker.count}/${MAX_CONCURRENT_JOBS})`);
    return;
  }
  
  try {
    // Calculate how many messages to fetch based on capacity
    const availableCapacity = MAX_CONCURRENT_JOBS - jobTracker.count;
    const maxMessages = Math.min(availableCapacity, 10); // SQS max is 10
    
    logger.debug(`Polling SQS for up to ${maxMessages} messages`);
    const messages = await sqsService.receiveMessages(maxMessages);
    
    if (messages.length > 0) {
      logger.info(`Received ${messages.length} messages from SQS`);
      
      // Process messages
      for (const message of messages) {
        const processed = await handleSQSMessage(message);
        if (!processed) {
          // Stop if we can't process more messages
          break;
        }
      }
    } else {
      logger.debug('No messages available in SQS queue');
    }
  } catch (error: any) {
    logger.error(`Error polling SQS: ${error.message}`, undefined, { error });
  }
}
export async function sendToTranscriptionQueue(message: Record<string, string>): Promise<void> {
  if (!sqsService || !process.env.SQS_TRANSCRIBE_EPISODE_URL || !message.episodeId) {
    logger.warn('Transcription queue not configured or message missing episodeId');
    return;
  }
  try {
    await sqsService.sendMessage(JSON.stringify(message), undefined, process.env.SQS_TRANSCRIBE_EPISODE_URL);
    logger.info(`Sent job ${message.episodeId} to transcription queue`);
  } catch (err: any) {
    logger.error(`Failed to send job ${message.episodeId} to transcription queue:`, err);
  }
}
/**
 * Start the SQS polling loop
 */
export function startSQSPolling(): void {
  if (!sqsService) {
    logger.warn('SQS service not configured, polling disabled');
    return;
  }
  
  logger.info(`Starting SQS polling with max ${MAX_CONCURRENT_JOBS} concurrent jobs`);
  logger.info('📬 SQS Message Types Supported:');
  logger.info('  - Video Enrichment: { "id": "episodeId", "url": "https://youtube.com/..." }');
  logger.info('  - New Entry: { "videoId": "...", "episodeTitle": "...", "originalUri": "https://youtube.com/...", "channelName": "...", "channelId": "...", ... }');
  logger.info('  - Legacy Downloads: { "jobId": "uuid" (optional), "url": "https://youtube.com/...", "channelId": "channel-id" (optional) }');
  logger.info('  - Note: jobId will be auto-generated if not provided for legacy downloads');
  logger.info('  - Note: channelId will be derived from uploader if not provided');
  
  // Initial poll
  pollSQSMessages();
  
  // Set up periodic polling
  setInterval(() => {
    pollSQSMessages();
  }, POLLING_INTERVAL_MS);
  
  // Set up health check logging
  setInterval(() => {
    logger.info(`SQS polling health check: ${jobTracker.count}/${MAX_CONCURRENT_JOBS} active jobs`, {
      workerId: WORKER_ID,
      activeJobs: jobTracker.count,
      maxJobs: MAX_CONCURRENT_JOBS,
      activeJobIds: jobTracker.activeJobIds
    });
  }, 60000); // Every minute
}

// Setup graceful shutdown
process.on('SIGINT', () => {
  logger.info(`SIGINT received, shutting down. ${jobTracker.count} jobs still active.`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info(`SIGTERM received, shutting down. ${jobTracker.count} jobs still active.`);
  process.exit(0);
});

export { jobTracker, pollSQSMessages, handleSQSMessage, moveToDLQ };

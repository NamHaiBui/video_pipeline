import { Message } from '@aws-sdk/client-sqs';
import { createSQSServiceFromEnv } from './lib/sqsService.js';
import { logger } from './lib/logger.js';
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
    
    // Validate that url is always present
    if (!jobData.url) {
      logger.warn(`Invalid job data in message ${messageId}: missing url`);
      return true; // Delete invalid messages
    }
    
    // Determine message type based on presence of 'id' field
    // If 'id' is present, it's an existing episode job; otherwise it's a new download job
    const isExistingEpisodeJob = !!(jobData.id);
    
    // Handle existing episode video download
    if (isExistingEpisodeJob) {
      logger.info(`Processing existing episode video download: ${jobData.id} - ${jobData.url}`);
      
      // Check if we can accept more jobs
      if (!jobTracker.canAcceptMoreJobs()) {
        logger.debug(`Cannot accept existing episode job ${jobData.id}, max concurrent jobs reached`);
        return false; // Keep in queue
      }
      
      // Start job tracking
      const trackingJobId = `existing-${jobData.id}`;
      if (!jobTracker.startJob(trackingJobId)) {
        return false; // Failed to start job, try again later
      }
      
      // Process existing episode job async
      downloadVideoForExistingEpisode(jobData.id!, jobData.url!)
        .then(() => {
          logger.info(`Existing episode video download ${jobData.id} completed successfully`);
          jobTracker.completeJob(trackingJobId);
          
          // Poll for new messages if we have capacity
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        })
        .catch(error => {
          logger.error(`Error processing existing episode job ${jobData.id}: ${error.message}`, undefined, { error });
          jobTracker.completeJob(trackingJobId);
          
          // Poll for new messages if we have capacity
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
    
    // Handle new download job
    // Ensure that jobId is always defined for new downloads
    if (!jobData.jobId || jobData.jobId.trim() === '') {
      // Try to use messageId first, fallback to generating a new UUID
      const generatedJobId = messageId && messageId !== 'unknown' ? messageId : uuidv4();
      logger.info(`Message ${messageId} has no jobId, generating: ${generatedJobId}`);
      jobData.jobId = generatedJobId;
    } else {
      jobData.jobId = jobData.jobId.trim();
    }
    
    // At this point jobId should always be defined and non-empty
    const channelInfo = jobData.channelId ? ` [Channel: ${jobData.channelId}]` : '';
    logger.debug(`Processing new download job: ${jobData.jobId} - ${jobData.url}${channelInfo}`);
    
    // Check if we can accept more jobs
    if (!jobTracker.canAcceptMoreJobs()) {
      logger.debug(`Cannot accept job ${jobData.jobId}, max concurrent jobs reached`);
      return false; // Keep in queue
    }
    
    // Start job
    if (!jobTracker.startJob(jobData.jobId)) {
      return false; // Failed to start job, try again later
    }
    
    // Process job async - pass the full jobData instead of just channelId
    processDownload(jobData.jobId, jobData.url, jobData)
      .then(() => {
        logger.info(`Job ${jobData.jobId} completed successfully`);
        jobTracker.completeJob(jobData.jobId!);
        
        // Poll for new messages if we have capacity
        if (jobTracker.canAcceptMoreJobs()) {
          pollSQSMessages();
        }
      })
      .catch(error => {
        logger.error(`Error processing job ${jobData.jobId}: ${error.message}`, undefined, { error });
        jobTracker.completeJob(jobData.jobId!);
        
        // Poll for new messages if we have capacity
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
    return false; // Keep in queue
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
  logger.info('  - New Downloads: { "jobId": "uuid" (optional), "url": "https://youtube.com/...", "channelId": "channel-id" (optional) }');
  logger.info('  - Existing Episode Videos: { "id": "episodeId", "url": "https://youtube.com/..." }');
  logger.info('  - Note: jobId will be auto-generated if not provided for new downloads');
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

export { jobTracker, pollSQSMessages };

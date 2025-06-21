import { Message } from '@aws-sdk/client-sqs';
import { createSQSServiceFromEnv } from './lib/sqsService.js';
import { logger } from './lib/logger.js';
import { SQSJobMessage } from './types.js';
import { processDownload } from './server.js';
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
    //Ensuring that jobId is always defined
    if (jobData.jobId === undefined || jobData.jobId === null || jobData.jobId.trim() === '') {
      logger.warn(`Message ${messageId} has no jobId, create jobId`);
      jobData.jobId = messageId; 
    }
    jobData.jobId = jobData.jobId.trim();;
    // Validate job data
    if (!jobData.url || !jobData.jobId) {
      logger.warn(`Invalid job data in message ${messageId}: missing url or jobId`);
      return true; // Delete invalid messages
    }
    
    // Check if we can accept more jobs
    if (!jobTracker.canAcceptMoreJobs()) {
      logger.debug(`Cannot accept job ${jobData.jobId}, max concurrent jobs reached`);
      return false; // Keep in queue
    }
    
    // Start job
    if (!jobTracker.startJob(jobData.jobId)) {
      return false; // Failed to start job, try again later
    }
    
    // Process job async
    processDownload(jobData.jobId, jobData.url)
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

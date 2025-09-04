import { Message, SQSClient, SendMessageCommand, GetQueueAttributesCommand, SendMessageCommandOutput, GetQueueAttributesCommandOutput } from '@aws-sdk/client-sqs';
import { createSQSServiceFromEnv } from './lib/sqsService_new.js';
import { logger } from './lib/utils/logger.js';
import { SQSJobMessage } from './types.js';
import { processDownload, downloadVideoForExistingEpisode } from './server.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { metrics, computeDefaultConcurrency } from './lib/utils/concurrency.js';

// Configuration
// Size workers to available CPU by default; can be overridden via MAX_CONCURRENT_JOBS
const MAX_CONCURRENT_JOBS = (() => {
  const fromEnv = parseInt(process.env.MAX_CONCURRENT_JOBS || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return computeDefaultConcurrency('cpu');
})();
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '300000', 10);
const WORKER_ID = `${os.hostname()}-${process.pid}`;

// Create SQS service
const sqsService = createSQSServiceFromEnv();

// Create a separate SQS client specifically for transcription queue
const createTranscriptionSQSClient = () => {
  if (!process.env.SQS_TRANSCRIBE_EPISODE_URL) {
    return null;
  }
  
  return new SQSClient({
    region: process.env.AWS_REGION || 'us-east-2',
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    } : undefined
  });
};

const transcriptionSQSClient = createTranscriptionSQSClient();

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
  metrics.gauge('jobs_in_flight', this.active.size);
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
  metrics.gauge('jobs_in_flight', this.active.size);
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

// Track empty polls for service shutdown
let consecutiveEmptyPolls = 0;
const MAX_EMPTY_POLLS = 2;


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
        .then(async () => {
          logger.info(`Video enrichment ${jobData.id} completed successfully`);
          jobTracker.completeJob(trackingJobId);
          if (sqsService) {
            await sqsService.deleteMessage(message.ReceiptHandle!);
          }
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        })
        .catch(async error => {
          logger.error(`Error processing video enrichment job ${jobData.id}: ${error.message}`, undefined, { error });
          jobTracker.completeJob(trackingJobId);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        });
    
      
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
        .then(async () => {
          logger.info(`New entry creation ${generatedJobId} completed successfully`);
            if (sqsService) {
              await sqsService.deleteMessage(message.ReceiptHandle!);
            }
          jobTracker.completeJob(trackingJobId);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        })
        .catch(async error => {
          logger.error(`Error processing new entry job ${generatedJobId}: ${error.message}`, undefined, { error });
          jobTracker.completeJob(trackingJobId);
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        });
      

      
      return true;
    }
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
    return true;
  } catch (error: any) {
    logger.error(`Error handling SQS message: ${error.message}`, undefined, { error });
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
      metrics.increment('sqs_messages_received_total', messages.length);
      consecutiveEmptyPolls = 0; // Reset counter when messages are found
      
      // Process messages
      for (const message of messages) {
        const processed = await handleSQSMessage(message);
        if (!processed) {
          break;
        }
      }
    } else {
  logger.debug('No messages available in SQS queue');
  metrics.increment('sqs_empty_polls_total', 1);
      
      consecutiveEmptyPolls++;
      
      if (consecutiveEmptyPolls >= MAX_EMPTY_POLLS) {
        // Only shut down if there are no active jobs AND no messages in queue
        if (jobTracker.count === 0) {
          logger.info(`Received ${consecutiveEmptyPolls} consecutive empty polls with no active jobs. Shutting down service.`);
          logger.info(`Final job status: ${jobTracker.count}/${MAX_CONCURRENT_JOBS} active jobs`);
          process.exit(0);
        } else {
          logger.info(`Received ${consecutiveEmptyPolls} consecutive empty polls, but ${jobTracker.count} jobs still active. Continuing to poll.`);
          // Reset consecutive empty polls to avoid immediate shutdown when jobs finish
          consecutiveEmptyPolls = Math.floor(MAX_EMPTY_POLLS / 2);
        }
      }
    }
  } catch (error: any) {
    logger.error(`Error polling SQS: ${error.message}`, undefined, { error });
  }
}
export async function sendToTranscriptionQueue(message: Record<string, string>): Promise<void> {
  if (!transcriptionSQSClient || !process.env.SQS_TRANSCRIBE_EPISODE_URL) {
    console.log('❌ Transcription queue not configured');
    return;
  }

  // Basic validation
  if (!message || typeof message !== 'object') {
    console.log('❌ Invalid message object');
    return;
  }

  if (!message.episodeId || message.episodeId.trim() === '') {
    console.log('❌ Missing episodeId in message');
    return;
  }

  try {
    // Convert message to JSON string
    const messageBody = JSON.stringify(message);
    
    // console.log('📤 Sending transcription message:', {
    //   episodeId: message.episodeId,
    //   audioUri: message.audioUri,
    //   bodyLength: messageBody.length,
    //   queueUrl: process.env.SQS_TRANSCRIBE_EPISODE_URL
    // });
    
    // Create and send the command directly
    const command = new SendMessageCommand({
      QueueUrl: process.env.SQS_TRANSCRIBE_EPISODE_URL,
      MessageBody: messageBody
    });
    
    const result: SendMessageCommandOutput = await transcriptionSQSClient.send(command);
    
    console.log(`✅ Transcription job sent: ${message.episodeId} -> ${result.MessageId}`);
    
    // Verify the message was sent by checking queue attributes
    try {
      const attrCommand = new GetQueueAttributesCommand({
        QueueUrl: process.env.SQS_TRANSCRIBE_EPISODE_URL,
        AttributeNames: ['ApproximateNumberOfMessages']
      });
      
      const attrs: GetQueueAttributesCommandOutput = await transcriptionSQSClient.send(attrCommand);
      console.log(`📊 Transcription queue now has: ${attrs.Attributes?.ApproximateNumberOfMessages || '0'} messages`);
    } catch (attrError: any) {
      console.log('⚠️ Could not check queue attributes:', attrError.message);
    }
    
  } catch (err: any) {
    console.error(`❌ Failed to send transcription job:`, err.message);
    throw err;
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

export { jobTracker, pollSQSMessages, handleSQSMessage, };

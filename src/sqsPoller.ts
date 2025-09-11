import { Message, SQSClient, SendMessageCommand, GetQueueAttributesCommand, SendMessageCommandOutput, GetQueueAttributesCommandOutput } from '@aws-sdk/client-sqs';
import { createSQSServiceFromEnv } from './lib/sqsService_new.js';
import { logger } from './lib/utils/logger.js';
import { SQSJobMessage } from './types.js';
import { processDownload, enableTaskProtection, disableTaskProtection, manageTaskProtection } from './server.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { metrics, computeDefaultConcurrency, isGreedyPerJob } from './lib/utils/concurrency.js';
// Removed RDS enrichment dependency

// Configuration
// Size workers to ensure 100% compute:
// - If greedy-per-job, run a single job to allow it to saturate all cores.
// - Otherwise, scale workers to available CPU cores.
// Can be overridden via MAX_CONCURRENT_JOBS.
const MAX_CONCURRENT_JOBS = (() => {
  const fromEnv = parseInt(process.env.MAX_CONCURRENT_JOBS || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return isGreedyPerJob() ? 1 : computeDefaultConcurrency('cpu');
})();
// Poll frequently by default (5s). Override with POLLING_INTERVAL_MS.
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '5000', 10);
const AUTO_EXIT_ON_IDLE = (process.env.AUTO_EXIT_ON_IDLE || 'false').toLowerCase() === 'true';
const WORKER_ID = `${os.hostname()}-${process.pid}`;

// Create SQS service
const sqsService = createSQSServiceFromEnv();

// Video enrichment removed: RDS client no longer needed here

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
    receiptHandle?: string;
    stopExtend?: () => void;
  }> = new Map();
  private maxConcurrent: number;
  
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    logger.info(`Job tracker initialized with max ${maxConcurrent} concurrent jobs`);
  }
  
  /**
   * Adjust maximum concurrent jobs at runtime
   */
  setMaxConcurrent(nextMax: number): void {
    const normalized = Math.max(1, Math.floor(nextMax));
    if (normalized !== this.maxConcurrent) {
      logger.info(`🔧 Adjusting max concurrent jobs: ${this.maxConcurrent} -> ${normalized}`);
      this.maxConcurrent = normalized;
      metrics.gauge('jobs_max_concurrent', this.maxConcurrent);
    }
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
  
  attachMessageContext(jobId: string, receiptHandle?: string, stopExtend?: () => void): void {
    const entry = this.active.get(jobId);
    if (entry) {
      if (receiptHandle) entry.receiptHandle = receiptHandle;
      if (stopExtend) entry.stopExtend = stopExtend;
      this.active.set(jobId, entry);
    }
  }
  
  /**
   * Mark a job as completed
   */
  completeJob(jobId: string): void {
    if (this.active.has(jobId)) {
      const job = this.active.get(jobId);
  try { job?.stopExtend?.(); } catch {}
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

// Poller state for graceful shutdown
let shuttingDown = false;
let pollInterval: NodeJS.Timeout | null = null;
let healthInterval: NodeJS.Timeout | null = null;
const REQUEUE_ON_TIMEOUT_SECONDS = parseInt(process.env.SQS_REQUEUE_ON_TIMEOUT_SECONDS || '30', 10);

// Track empty polls for service shutdown
let consecutiveEmptyPolls = 0;
const MAX_EMPTY_POLLS = 2;

// Auto-scale job concurrency to saturate CPU unless explicitly overridden via MAX_CONCURRENT_JOBS
const AUTOSCALE_JOBS = !(Number.isFinite(parseInt(process.env.MAX_CONCURRENT_JOBS || '', 10)) && parseInt(process.env.MAX_CONCURRENT_JOBS || '', 10) > 0);
if (AUTOSCALE_JOBS) {
  setInterval(() => {
    try {
      const target = isGreedyPerJob() ? 1 : computeDefaultConcurrency('cpu');
      jobTracker.setMaxConcurrent(target);
      // If capacity increased, trigger a poll
      if (jobTracker.canAcceptMoreJobs()) {
        pollSQSMessages();
      }
    } catch (e: any) {
      logger.warn(`Autoscale concurrency check failed: ${e?.message || e}`);
    }
  }, Math.max(15000, parseInt(process.env.AUTOSCALE_INTERVAL_MS || '30000', 10))); // 30s default
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
    const isNewEntry = !!(jobData.videoId && jobData.episodeTitle && jobData.originalUri);
    
    // Validate message structure
  if (isNewEntry) {
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
      
  // Apply ECS task protection and start visibility extender for long-running processing
  try { await enableTaskProtection(120); } catch {}
  // Start visibility extender for long-running processing
  const stopExtend = sqsService ? sqsService.startVisibilityExtender(message.ReceiptHandle!, 120, 900) : () => {};
  jobTracker.attachMessageContext(trackingJobId, message.ReceiptHandle!, stopExtend);
  // Process new entry job async - pass the full jobData with new entry structure
  processDownload(generatedJobId, jobData.originalUri!, jobData)
        .then(async () => {
          logger.info(`New entry creation ${generatedJobId} completed successfully`);
    stopExtend();
            if (sqsService) {
              await sqsService.deleteMessage(message.ReceiptHandle!);
            }
          jobTracker.completeJob(trackingJobId);
          try { await manageTaskProtection(); } catch {}
          if (jobTracker.canAcceptMoreJobs()) {
            pollSQSMessages();
          }
        })
        .catch(async error => {
          logger.error(`Error processing new entry job ${generatedJobId}: ${error.message}`, undefined, { error });
      stopExtend();
          jobTracker.completeJob(trackingJobId);
          try { await manageTaskProtection(); } catch {}
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
  const legacyJobId = jobData.jobId as string;
  // Apply ECS task protection and start visibility extender for long-running processing
  try { await enableTaskProtection(120); } catch {}
  // Start visibility extender for long-running processing
  const stopExtend = sqsService ? sqsService.startVisibilityExtender(message.ReceiptHandle!, 120, 900) : () => {};
  jobTracker.attachMessageContext(legacyJobId, message.ReceiptHandle!, stopExtend);
  // Process legacy job async
  processDownload(legacyJobId, jobData.url)
      .then(async () => {
    logger.info(`Legacy download ${legacyJobId} completed successfully`);
        stopExtend();
        if (sqsService) {
          await sqsService.deleteMessage(message.ReceiptHandle!);
        }
  jobTracker.completeJob(legacyJobId);
    try { await disableTaskProtection(); } catch {}
        if (jobTracker.canAcceptMoreJobs()) {
          pollSQSMessages();
        }
      })
      .catch(async error => {
    logger.error(`Error processing legacy job ${legacyJobId}: ${error.message}`, undefined, { error });
    stopExtend();
  jobTracker.completeJob(legacyJobId);
  try { await disableTaskProtection(); } catch {}
        if (jobTracker.canAcceptMoreJobs()) {
          pollSQSMessages();
        }
      });

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
  if (shuttingDown) {
    logger.debug('Shutdown in progress, skipping SQS poll');
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
        // Only shut down automatically if explicitly enabled
        if (AUTO_EXIT_ON_IDLE) {
          if (jobTracker.count === 0) {
            logger.info(`Received ${consecutiveEmptyPolls} consecutive empty polls with no active jobs. Shutting down service (AUTO_EXIT_ON_IDLE=true).`);
            logger.info(`Final job status: ${jobTracker.count}/${MAX_CONCURRENT_JOBS} active jobs`);
            process.exit(0);
          } else {
            logger.info(`Received ${consecutiveEmptyPolls} consecutive empty polls, but ${jobTracker.count} jobs still active. Continuing to poll.`);
            // Reset consecutive empty polls to avoid immediate shutdown when jobs finish
            consecutiveEmptyPolls = Math.floor(MAX_EMPTY_POLLS / 2);
          }
        } else {
          // Just log and keep running in service mode
          logger.debug(`Idle polls threshold reached (${consecutiveEmptyPolls}) with ${jobTracker.count} active jobs. Service will continue running.`);
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
    
    console.log('📤 Sending transcription message:', {
      episodeId: message.episodeId,
      audioUri: message.audioUri,
      bodyLength: messageBody.length,
      queueUrl: process.env.SQS_TRANSCRIBE_EPISODE_URL
    });
    
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
  if (pollInterval) {
    logger.debug('SQS polling already started');
    return;
  }
  
  logger.info(`Starting SQS polling with max ${MAX_CONCURRENT_JOBS} concurrent jobs`);
  logger.info('📬 SQS Message Types Supported:');
  logger.info('  - New Entry: { "videoId": "...", "episodeTitle": "...", "originalUri": "https://youtube.com/...", "channelName": "...", "channelId": "...", ... }');
  logger.info('  - Legacy Downloads: { "jobId": "uuid" (optional), "url": "https://youtube.com/...", "channelId": "channel-id" (optional) }');
  logger.info('  - Note: jobId will be auto-generated if not provided for legacy downloads');
  logger.info('  - Note: channelId will be derived from uploader if not provided');
  
  // Initial poll
  pollSQSMessages();
  
  // Set up periodic polling
  pollInterval = setInterval(() => {
    if (!shuttingDown) {
      pollSQSMessages();
    }
  }, POLLING_INTERVAL_MS);
  
  // Set up health check logging
  healthInterval = setInterval(() => {
    logger.info(`SQS polling health check: ${jobTracker.count}/${MAX_CONCURRENT_JOBS} active jobs`, {
      workerId: WORKER_ID,
      activeJobs: jobTracker.count,
      maxJobs: MAX_CONCURRENT_JOBS,
      activeJobIds: jobTracker.activeJobIds
    });
  }, 60000); // Every minute
}

function stopPolling(): void {
  shuttingDown = true;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

export async function requestPollerShutdown(graceMs: number = parseInt(process.env.SHUTDOWN_GRACE_MS || '180000', 10)): Promise<void> {
  stopPolling();
  const start = Date.now();
  logger.info(`SQS poller draining started. Waiting up to ${Math.round(graceMs/1000)}s for ${jobTracker.count} active jobs to finish.`);
  while (jobTracker.count > 0 && Date.now() - start < graceMs) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (jobTracker.count === 0) {
    logger.info('SQS poller drain complete. No active jobs remaining.');
  } else {
    logger.warn(`SQS poller drain timeout reached with ${jobTracker.count} job(s) still active. Re-queuing in-flight messages with ${REQUEUE_ON_TIMEOUT_SECONDS}s visibility.`);
    // Best-effort: stop extenders and shorten visibility so another worker can pick them up soon
    for (const jobId of jobTracker.activeJobIds) {
      const entry: any = (jobTracker as any).active.get(jobId);
      try { entry?.stopExtend?.(); } catch {}
      if (sqsService && entry?.receiptHandle) {
        try {
          await sqsService.changeMessageVisibility(entry.receiptHandle, REQUEUE_ON_TIMEOUT_SECONDS);
        } catch (e: any) {
          logger.error(`Failed to adjust visibility for job ${jobId}: ${e?.message || e}`);
        }
      }
    }
  }
}

// Setup graceful shutdown handlers (best-effort; server may also coordinate)
process.on('SIGINT', async () => {
  logger.info(`SIGINT received by poller. Initiating graceful drain with ${jobTracker.count} active job(s).`);
  await requestPollerShutdown();
});

process.on('SIGTERM', async () => {
  logger.info(`SIGTERM received by poller. Initiating graceful drain with ${jobTracker.count} active job(s).`);
  await requestPollerShutdown();
});

export { jobTracker, pollSQSMessages, handleSQSMessage, };

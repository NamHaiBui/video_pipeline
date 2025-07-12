import { 
  SQSClient, 
  ReceiveMessageCommand, 
  DeleteMessageCommand, 
  SendMessageCommand,
  ReceiveMessageCommandOutput, 
  Message 
} from '@aws-sdk/client-sqs';
import { logger } from './utils/logger.js';

export interface SQSServiceConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpointUrl?: string;
  queueUrl: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
}

export class SQSService {
  private client: SQSClient;
  private queueUrl: string;
  private maxMessages: number;
  private waitTimeSeconds: number;

  constructor(config: SQSServiceConfig) {
    this.client = new SQSClient({
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      } : undefined,
      endpoint: config.endpointUrl
    });

    this.queueUrl = config.queueUrl;
    this.maxMessages = config.maxMessages || 10;
    this.waitTimeSeconds = config.waitTimeSeconds || 20;
  }

  /**
   * Poll for messages from the SQS queue
   * @param maxMessages Optional override for the maximum number of messages to receive
   * @returns List of messages received from the queue
   */
  async receiveMessages(maxMessages?: number): Promise<Message[]> {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maxMessages || this.maxMessages,
        WaitTimeSeconds: this.waitTimeSeconds,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All']
      });

      const response: ReceiveMessageCommandOutput = await this.client.send(command);
      return response.Messages || [];
    } catch (error: any) {
      logger.error(`Failed to receive SQS messages: ${error.message}`, undefined, { error });
      throw error;
    }
  }

  /**
   * Delete a message from the queue after processing
   * @param receiptHandle Receipt handle of the message to delete
   */
  async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      const command = new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle
      });

      await this.client.send(command);
      logger.debug(`Deleted message from queue: ${receiptHandle.substring(0, 10)}...`);
    } catch (error: any) {
      logger.error(`Failed to delete SQS message: ${error.message}`, undefined, { receiptHandle, error });
      throw error;
    }
  }

  /**
   * Send a message to the SQS queue
   * @param messageBody Message body to send
   * @param messageAttributes Optional message attributes
   * @param queueUrl Optional override for the queue URL
   */
  async sendMessage(
    messageBody: string, 
    messageAttributes?: Record<string, any>,
    queueUrl?: string
  ): Promise<string> {
    try {
      const command = new SendMessageCommand({
        QueueUrl: queueUrl || this.queueUrl,
        MessageBody: messageBody,
        MessageAttributes: messageAttributes
      });

      const response = await this.client.send(command);
      logger.info(`Message sent to SQS queue: ${response.MessageId}`);
      return response.MessageId || '';
    } catch (error: any) {
      logger.error(`Failed to send SQS message: ${error.message}`, undefined, { error });
      throw error;
    }
  }

  /**
   * Process all messages in the queue until it's empty
   * @param messageHandler Function to process each message
   * @returns Number of messages processed
   */
  async processQueueUntilEmpty(
    messageHandler: (message: Message) => Promise<void>
  ): Promise<number> {
    let processedCount = 0;
    let emptyReceiveCount = 0;
    const MAX_EMPTY_RECEIVES = 3; // After receiving 3 empty responses, consider the queue empty
    
    logger.info(`Starting to poll messages from ${this.queueUrl}`);
    
    while (emptyReceiveCount < MAX_EMPTY_RECEIVES) {
      const messages = await this.receiveMessages();
      
      if (messages.length === 0) {
        emptyReceiveCount++;
        logger.debug(`No messages received (empty receive count: ${emptyReceiveCount})`);
        continue;
      }
      
      emptyReceiveCount = 0; // Reset empty receive counter when we get messages
      logger.info(`Received ${messages.length} messages from SQS`);
      
      for (const message of messages) {
        try {
          logger.debug(`Processing message: ${message.MessageId}`);
          await messageHandler(message);
          await this.deleteMessage(message.ReceiptHandle!);
          processedCount++;
        } catch (error: any) {
          logger.error(`Error processing message ${message.MessageId}: ${error.message}`, undefined, {
            messageId: message.MessageId,
            error
          });
          // Don't delete the message to allow for retry
        }
      }
    }
    
    logger.info(`Finished polling. Processed ${processedCount} messages.`);
    return processedCount;
  }
}

/**
 * Create an SQS service from environment variables
 */
export function createSQSServiceFromEnv(): SQSService | null {
  try {
    const queueUrl = process.env.SQS_QUEUE_URL;
    
    if (!queueUrl) {
      logger.warn('SQS_QUEUE_URL is not configured. SQS service will not be available.');
      return null;
    }

    const region = process.env.AWS_REGION || 'us-east-1';
    
    const config: SQSServiceConfig = {
      region,
      queueUrl,
      maxMessages: parseInt(process.env.SQS_MAX_MESSAGES || '10', 10),
      waitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME || '20', 10)
    };
    
    // Use production AWS credentials
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      config.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    }
    
    return new SQSService(config);
  } catch (error: any) {
    logger.error(`Failed to create SQS service: ${error.message}`);
    return null;
  }
}

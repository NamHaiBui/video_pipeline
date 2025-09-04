import { 
  SQSClient, 
  ReceiveMessageCommand, 
  DeleteMessageCommand, 
  SendMessageCommand,
  GetQueueAttributesCommand,
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
   * Send a message to the SQS queue - SIMPLIFIED VERSION
   */
  async sendMessage(
    messageBody: string, 
    messageAttributes?: Record<string, any>,
    queueUrl?: string
  ): Promise<string> {
    // STEP 1: Strict validation
    if (!messageBody) {
      throw new Error('Message body is required');
    }
    
    if (typeof messageBody !== 'string') {
      throw new Error(`Message body must be a string, got: ${typeof messageBody}`);
    }
    
    if (messageBody.trim() === '') {
      throw new Error('Message body cannot be empty');
    }
    
    const targetQueue = queueUrl || this.queueUrl;
    if (!targetQueue) {
      throw new Error('Queue URL is required');
    }

    // STEP 2: Create command with only required parameters
    const command = new SendMessageCommand({
      QueueUrl: targetQueue,
      MessageBody: messageBody
    });

    console.log(`📤 Sending message to SQS: ${targetQueue}`);
    console.log(`📏 Message length: ${messageBody.length} characters`);
    console.log(`🔍 Message preview: ${messageBody.substring(0, 100)}...`);

    try {
      // STEP 3: Send the message
      const result = await this.client.send(command);
      
      if (!result.MessageId) {
        throw new Error('Failed to get MessageId from AWS response');
      }
      
      console.log(`✅ Message sent successfully: ${result.MessageId}`);
      return result.MessageId;
      
    } catch (error: any) {
      console.error(`❌ SQS send failed:`, error.message);
      throw new Error(`SQS send failed: ${error.message}`);
    }
  }

  /**
   * Poll for messages from the SQS queue
   */
  async receiveMessages(maxMessages?: number): Promise<Message[]> {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maxMessages || this.maxMessages,
        WaitTimeSeconds: this.waitTimeSeconds,
        VisibilityTimeout: 14400, // Default visibility timeout
        AttributeNames: ['All']
      });

      const result: ReceiveMessageCommandOutput = await this.client.send(command);
      return result.Messages || [];
    } catch (error: any) {
      logger.error(`Failed to receive SQS messages: ${error.message}`, undefined, { error });
      return [];
    }
  }

  /**
   * Delete a message from the SQS queue
   */
  async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      const command = new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle
      });

      await this.client.send(command);
    } catch (error: any) {
      logger.error(`Failed to delete SQS message: ${error.message}`, undefined, { error });
      throw error;
    }
  }

  /**
   * Get queue attributes
   */
  async getQueueAttributes(queueUrl?: string): Promise<Record<string, string> | undefined> {
    try {
      const command = new GetQueueAttributesCommand({
        QueueUrl: queueUrl || this.queueUrl,
        AttributeNames: ['All']
      });

      const result = await this.client.send(command);
      return result.Attributes;
    } catch (error: any) {
      logger.error(`Failed to get queue attributes: ${error.message}`, undefined, { error });
      throw error;
    }
  }
}

/**
 * Create SQS service from environment variables
 */
export function createSQSServiceFromEnv(): SQSService | null {
  const region = process.env.AWS_REGION || 'us-east-2';
  const queueUrl = process.env.SQS_QUEUE_URL;
  
  if (!queueUrl) {
    logger.warn('SQS_QUEUE_URL not configured');
    return null;
  }

  const config: SQSServiceConfig = {
    region,
    queueUrl,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: process.env.SQS_ENDPOINT_URL,
    maxMessages: parseInt(process.env.SQS_MAX_MESSAGES || '10', 10),
  };

  return new SQSService(config);
}

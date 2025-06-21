/**
 * CloudWatch Logger Service for Video Pipeline
 * 
 * This service provides structured logging with direct AWS CloudWatch Logs integration
 * without Winston dependency. It supports both console output and CloudWatch streaming.
 * 
 * Features:
 * - Direct AWS SDK CloudWatch Logs integration
 * - Structured JSON logging
 * - Job correlation via jobId
 * - Metrics logging support
 * - Professional error handling
 * 
 * @author Video Pipeline Team
 * @version 1.0.0
 */

import { 
  CloudWatchLogsClient, 
  CreateLogGroupCommand, 
  CreateLogStreamCommand, 
  PutLogEventsCommand,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  ResourceAlreadyExistsException,
  ResourceNotFoundException 
} from '@aws-sdk/client-cloudwatch-logs';
import { LOGGING, ENV_VARS } from '../constants.js';

/**
 * Log levels in order of severity
 */
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service: string;
  environment: string;
  version: string;
  jobId?: string;
  event?: string;
  metadata?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

/**
 * Logger configuration interface
 */
interface LoggerConfig {
  level: LogLevel;
  service: string;
  environment: string;
  version: string;
  cloudWatch: {
    logGroupName: string;
    logStreamName: string;
    awsRegion: string;
    enabled: boolean;
    batchSize: number;
    flushInterval: number;
  };
}

/**
 * CloudWatch Logger class
 */
class CloudWatchLogger {
  private config: LoggerConfig;
  private cloudWatchClient: CloudWatchLogsClient | null = null;
  private logBuffer: LogEntry[] = [];
  private isSetup = false;
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Initialize the logger with configuration
   */
  constructor() {
    this.config = this.getConfiguration();
    this.setupPeriodicFlush();
    // Initialize CloudWatch asynchronously
    this.initializeCloudWatch().catch(error => {
      console.warn('⚠️ Failed to initialize CloudWatch in constructor:', error.message);
    });
  }

  /**
   * Get logger configuration from environment variables
   */
  private getConfiguration(): LoggerConfig {
    return {
      level: this.parseLogLevel(process.env[ENV_VARS.LOG_LEVEL] || LOGGING.DEFAULT_LEVEL),
      service: LOGGING.SERVICE_NAME,
      environment: process.env[ENV_VARS.NODE_ENV] || LOGGING.DEFAULT_ENVIRONMENT,
      version: process.env.npm_package_version || '1.0.0',
      cloudWatch: {
        logGroupName: process.env[ENV_VARS.CLOUDWATCH_LOG_GROUP] || LOGGING.DEFAULT_LOG_GROUP,
        logStreamName: process.env[ENV_VARS.CLOUDWATCH_LOG_STREAM] || LOGGING.DEFAULT_LOG_STREAM,
        awsRegion: process.env[ENV_VARS.AWS_REGION] || LOGGING.DEFAULT_AWS_REGION,
        enabled: process.env[ENV_VARS.NODE_ENV] === 'production' || 
                process.env[ENV_VARS.NODE_ENV] === 'development',
        batchSize: 25, // CloudWatch Logs max batch size
        flushInterval: 5000 // Flush every 5 seconds
      }
    };
  }

  /**
   * Parse log level string to enum
   */
  private parseLogLevel(level: string): LogLevel {
    const normalizedLevel = level.toLowerCase();
    if (Object.values(LogLevel).includes(normalizedLevel as LogLevel)) {
      return normalizedLevel as LogLevel;
    }
    return LogLevel.INFO;
  }

  /**
   * Initialize CloudWatch client if enabled
   */
  private async initializeCloudWatch(): Promise<void> {
    if (!this.config.cloudWatch.enabled) {
      console.log('📝 CloudWatch logging disabled');
      return;
    }

    try {
      const clientConfig: any = {
        region: this.config.cloudWatch.awsRegion,
      };

      // Add AWS credentials if provided
      if (process.env[ENV_VARS.AWS_ACCESS_KEY_ID] && process.env[ENV_VARS.AWS_SECRET_ACCESS_KEY]) {
        clientConfig.credentials = {
          accessKeyId: process.env[ENV_VARS.AWS_ACCESS_KEY_ID],
          secretAccessKey: process.env[ENV_VARS.AWS_SECRET_ACCESS_KEY]
        };
      }

      this.cloudWatchClient = new CloudWatchLogsClient(clientConfig);
      await this.ensureLogGroupAndStream();
      
      console.log(`📝 CloudWatch logging initialized: ${this.config.cloudWatch.logGroupName}/${this.config.cloudWatch.logStreamName}`);
    } catch (error: any) {
      console.warn('⚠️ Failed to initialize CloudWatch logging:', error.message);
      this.cloudWatchClient = null;
    }
  }

  /**
   * Ensure log group and stream exist
   */
  private async ensureLogGroupAndStream(): Promise<void> {
    if (!this.cloudWatchClient) return;

    try {
      // Create log group if it doesn't exist
      try {
        await this.cloudWatchClient.send(new CreateLogGroupCommand({
          logGroupName: this.config.cloudWatch.logGroupName
        }));
        console.log(`✅ Created CloudWatch log group: ${this.config.cloudWatch.logGroupName}`);
      } catch (error: any) {
        if (error instanceof ResourceAlreadyExistsException) {
          console.log(`ℹ️ CloudWatch log group already exists: ${this.config.cloudWatch.logGroupName}`);
        } else {
          console.warn(`⚠️ Failed to create log group: ${error.message}`);
          throw error;
        }
      }

      // Create log stream if it doesn't exist
      try {
        await this.cloudWatchClient.send(new CreateLogStreamCommand({
          logGroupName: this.config.cloudWatch.logGroupName,
          logStreamName: this.config.cloudWatch.logStreamName
        }));
        console.log(`✅ Created CloudWatch log stream: ${this.config.cloudWatch.logStreamName}`);
      } catch (error: any) {
        if (error instanceof ResourceAlreadyExistsException) {
          console.log(`ℹ️ CloudWatch log stream already exists: ${this.config.cloudWatch.logStreamName}`);
        } else {
          console.warn(`⚠️ Failed to create log stream: ${error.message}`);
          throw error;
        }
      }

      this.isSetup = true;
      console.log(`✅ CloudWatch logging setup complete`);
    } catch (error: any) {
      console.warn('⚠️ Failed to setup CloudWatch log group/stream:', error.message);
      this.isSetup = false;
    }
  }

  /**
   * Setup periodic flush for buffered logs
   */
  private setupPeriodicFlush(): void {
    this.flushTimer = setInterval(() => {
      this.flushLogs();
    }, this.config.cloudWatch.flushInterval);

    // Flush logs on process exit
    process.on('beforeExit', () => this.flushLogs());
    process.on('SIGINT', () => this.flushLogs());
    process.on('SIGTERM', () => this.flushLogs());
  }

  /**
   * Check if log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
    const configLevelIndex = levels.indexOf(this.config.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex <= configLevelIndex;
  }

  /**
   * Create structured log entry
   */
  private createLogEntry(level: LogLevel, message: string, metadata?: Record<string, any>): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.config.service,
      environment: this.config.environment,
      version: this.config.version,
      ...metadata
    };
  }

  /**
   * Output log entry to console
   */
  private outputToConsole(entry: LogEntry): void {
    const { timestamp, level, message, jobId, service } = entry;
    const jobIdStr = jobId ? `[${jobId}]` : '';
    const levelColor = this.getColorForLevel(level);
    
    console.log(`${timestamp} [${service}] ${levelColor}${level.toUpperCase()}\x1b[0m${jobIdStr}: ${message}`);
    
    // Output metadata if present
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      console.log('  Metadata:', JSON.stringify(entry.metadata, null, 2));
    }
    
    // Output error details if present
    if (entry.error) {
      console.error('  Error:', entry.error.message);
      if (entry.error.stack) {
        console.error('  Stack:', entry.error.stack);
      }
    }
  }

  /**
   * Get ANSI color code for log level
   */
  private getColorForLevel(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR: return '\x1b[31m'; // Red
      case LogLevel.WARN: return '\x1b[33m';  // Yellow
      case LogLevel.INFO: return '\x1b[36m';  // Cyan
      case LogLevel.DEBUG: return '\x1b[37m'; // White
      default: return '\x1b[0m';              // Reset
    }
  }

  /**
   * Add log entry to buffer for CloudWatch
   */
  private bufferLogEntry(entry: LogEntry): void {
    if (!this.cloudWatchClient || !this.isSetup) return;

    this.logBuffer.push(entry);

    // Flush immediately if buffer is full
    if (this.logBuffer.length >= this.config.cloudWatch.batchSize) {
      this.flushLogs();
    }
  }

  /**
   * Flush buffered logs to CloudWatch
   */
  private async flushLogs(): Promise<void> {
    if (!this.cloudWatchClient || !this.isSetup || this.logBuffer.length === 0) {
      return;
    }

    try {
      const logEvents = this.logBuffer.map(entry => ({
        timestamp: new Date(entry.timestamp).getTime(),
        message: JSON.stringify(entry)
      }));

      await this.cloudWatchClient.send(new PutLogEventsCommand({
        logGroupName: this.config.cloudWatch.logGroupName,
        logStreamName: this.config.cloudWatch.logStreamName,
        logEvents
      }));

      this.logBuffer = []; // Clear buffer after successful flush
    } catch (error: any) {
      console.warn('⚠️ Failed to flush logs to CloudWatch:', error.message);
    }
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, metadata?: Record<string, any>): void {
    if (!this.shouldLog(level)) return;

    const entry = this.createLogEntry(level, message, metadata);
    
    // Always output to console
    this.outputToConsole(entry);
    
    // Buffer for CloudWatch if enabled
    this.bufferLogEntry(entry);
  }

  /**
   * Log error message
   */
  public error(message: string, error?: Error, metadata?: Record<string, any>): void {
    const logMetadata = { ...metadata };
    
    if (error) {
      logMetadata.error = {
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      };
    }
    
    this.log(LogLevel.ERROR, message, logMetadata);
  }

  /**
   * Log warning message
   */
  public warn(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, metadata);
  }

  /**
   * Log info message
   */
  public info(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, metadata);
  }

  /**
   * Log debug message
   */
  public debug(message: string, metadata?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  /**
   * Create child logger with additional context
   */
  public child(context: Record<string, any>): CloudWatchLogger {
    const childLogger = new CloudWatchLogger();
    // Override the log method to include context
    const originalLog = childLogger.log.bind(childLogger);
    childLogger.log = (level: LogLevel, message: string, metadata?: Record<string, any>) => {
      const mergedMetadata = { ...context, ...metadata };
      originalLog(level, message, mergedMetadata);
    };
    return childLogger;
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushLogs(); // Final flush
  }
}

// Create singleton logger instance
export const logger = new CloudWatchLogger();

// Helper functions for structured logging
export const createJobLogger = (jobId: string): CloudWatchLogger => {
  return logger.child({ jobId });
};

export const logJobEvent = (jobId: string, event: string, data?: any): void => {
  logger.info(`Job ${event}`, {
    jobId,
    event,
    ...data
  });
};

export const logJobError = (jobId: string, error: Error, context?: any): void => {
  logger.error('Job error occurred', error, {
    jobId,
    ...context
  });
};

// Metrics logging helper
export const logMetric = (
  metricName: string, 
  value: number, 
  unit: string = 'Count', 
  dimensions?: Record<string, string>
): void => {
  logger.info('Metric recorded', {
    metric: {
      name: metricName,
      value,
      unit,
      dimensions,
      timestamp: new Date().toISOString()
    }
  });
};

// Export logger configuration for testing
export const getLoggerConfig = (): any => {
  return (logger as any).config;
};

export default logger;

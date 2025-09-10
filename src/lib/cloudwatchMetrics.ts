import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { logger } from './utils/logger.js';

let cwClient: CloudWatchClient | null = null;

function getClient(): CloudWatchClient | null {
  if (process.env.VALIDATION_METRICS_ENABLED === 'false') return null;
  if (!cwClient) {
    try {
      const region = process.env.AWS_REGION || 'us-east-1';
      cwClient = new CloudWatchClient({ region });
    } catch (e: any) {
      logger.warn(`CloudWatch client init failed: ${e?.message || e}`);
      cwClient = null;
    }
  }
  return cwClient;
}

export interface ValidationMetricParams {
  episodeId: string;
  success: boolean;
  errors: number;
  warnings?: number;
  stage?: string; // e.g., post_process, integrity_scan
}

export async function emitValidationMetric(params: ValidationMetricParams): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const namespace = process.env.VALIDATION_METRIC_NAMESPACE || 'SPICE/VideoPipelineValidation';
    const dimensions = [
      { Name: 'Environment', Value: process.env.NODE_ENV || 'dev' },
      { Name: 'Stage', Value: params.stage || 'post_process' }
    ];
    const timestamp = new Date();
    const metricData = [
      {
        MetricName: 'PostProcessValidationFailed',
        Dimensions: dimensions,
        Timestamp: timestamp,
        Value: params.success ? 0 : 1,
      },
      {
        MetricName: 'PostProcessValidationErrors',
        Dimensions: dimensions,
        Timestamp: timestamp,
        Value: params.errors,
      }
    ];
    if (params.warnings !== undefined) {
      metricData.push({
        MetricName: 'PostProcessValidationWarnings',
        Dimensions: dimensions,
        Timestamp: timestamp,
        Value: params.warnings,
      });
    }
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: metricData
    }));
  } catch (e: any) {
    logger.warn('Failed to emit CloudWatch validation metric', e?.message || e);
  }
}

export async function emitIntegrityScanMetric(summary: { scanned: number; errors: number; warnings: number; }): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const namespace = process.env.VALIDATION_METRIC_NAMESPACE || 'SPICE/VideoPipelineValidation';
    const dimensions = [
      { Name: 'Environment', Value: process.env.NODE_ENV || 'dev' },
      { Name: 'Stage', Value: 'integrity_scan' }
    ];
    const timestamp = new Date();
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
  { MetricName: 'IntegrityScanErrors', Dimensions: dimensions, Timestamp: timestamp, Value: summary.errors },
  { MetricName: 'IntegrityScanWarnings', Dimensions: dimensions, Timestamp: timestamp, Value: summary.warnings },
  { MetricName: 'IntegrityScanTotal', Dimensions: dimensions, Timestamp: timestamp, Value: summary.scanned },
  { MetricName: 'IntegrityScanFailed', Dimensions: dimensions, Timestamp: timestamp, Value: summary.errors > 0 ? 1 : 0 }
      ]
    }));
  } catch (e: any) {
    logger.warn('Failed to emit CloudWatch integrity scan metric', e?.message || e);
  }
}

/**
 * Emit a metric for a yt-dlp fatal error to allow CloudWatch alarms.
 * Value: 1 per emission; include optional error category.
 */
export async function emitYtdlpErrorMetric(errorType: string = 'generic', isExistingEpisode: boolean = false): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const namespace = process.env.VALIDATION_METRIC_NAMESPACE || 'SPICE/VideoPipelineValidation';
    const dimensions = [
      { Name: 'Environment', Value: process.env.NODE_ENV || 'dev' },
      { Name: 'Stage', Value: 'yt_dlp' },
      { Name: 'ErrorType', Value: errorType.substring(0, 50) },
      { Name: 'Flow', Value: isExistingEpisode ? 'existing_episode' : 'new_or_legacy' }
    ];
    const timestamp = new Date();
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        { MetricName: 'YtdlpFatalError', Dimensions: dimensions, Timestamp: timestamp, Value: 1 },
      ]
    }));
  } catch (e: any) {
    logger.warn('Failed to emit CloudWatch yt-dlp error metric', e?.message || e);
  }
}

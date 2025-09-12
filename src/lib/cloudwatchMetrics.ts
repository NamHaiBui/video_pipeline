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

function getNamespace(kind: 'validation' | 'ops' = 'ops'): string {
  if (kind === 'validation') {
    return process.env.VALIDATION_METRIC_NAMESPACE || 'SPICE/VideoPipelineValidation';
  }
  return process.env.OP_METRIC_NAMESPACE || 'SPICE/VideoPipelineOps';
}

function baseDimensions(extra?: { Name: string; Value: string }[]): { Name: string; Value: string }[] {
  const dims: { Name: string; Value: string }[] = [
    { Name: 'Environment', Value: process.env.NODE_ENV || 'dev' },
  ];
  if (extra && extra.length) dims.push(...extra);
  return dims;
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
    const namespace = getNamespace('validation');
    const dimensions = baseDimensions([
      { Name: 'Stage', Value: params.stage || 'post_process' }
    ]);
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
    const namespace = getNamespace('validation');
    const dimensions = baseDimensions([
      { Name: 'Stage', Value: 'integrity_scan' }
    ]);
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
    const namespace = getNamespace('validation');
    const dimensions = baseDimensions([
      { Name: 'Stage', Value: 'yt_dlp' },
      { Name: 'ErrorType', Value: errorType.substring(0, 50) },
      { Name: 'Flow', Value: isExistingEpisode ? 'existing_episode' : 'new_or_legacy' }
    ]);
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

export type PipelineStep =
  | 'sqs_handle_message'
  | 'metadata_fetch'
  | 'audio_download'
  | 'video_download'
  | 'merge'
  | 's3_upload_audio'
  | 's3_upload_video'
  | 's3_download'
  | 'rds_store_episode'
  | 'rds_update_episode'
  | 'hls_render'
  | 'transcription_enqueue'
  | 'validation'
  | 'guest_extraction'
  | 'task_protection'
  | 'poller'
  | 'pipeline'
  | 'unhandled';

/** Emit a StepFailure=1 with dimensions { Step, ErrorName?, Component? } */
export async function emitStepFailure(step: PipelineStep, errorName?: string, component?: string, extraDims?: { Name: string; Value: string }[]): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const namespace = getNamespace('ops');
    const dims = baseDimensions([
      { Name: 'Step', Value: step },
      ...(component ? [{ Name: 'Component', Value: component }] : []),
      ...(errorName ? [{ Name: 'ErrorName', Value: String(errorName).slice(0, 64) }] : []),
      ...(extraDims || [])
    ]);
    const ts = new Date();
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        { MetricName: 'StepFailure', Dimensions: dims, Timestamp: ts, Value: 1 },
      ]
    }));
  } catch (e: any) {
    logger.warn('Failed to emit StepFailure metric', e?.message || e);
  }
}

/** Emit a StepSuccess=1 for successful completion of a step */
export async function emitStepSuccess(step: PipelineStep, component?: string, extraDims?: { Name: string; Value: string }[]): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const namespace = getNamespace('ops');
    const dims = baseDimensions([
      { Name: 'Step', Value: step },
      ...(component ? [{ Name: 'Component', Value: component }] : []),
      ...(extraDims || [])
    ]);
    const ts = new Date();
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        { MetricName: 'StepSuccess', Dimensions: dims, Timestamp: ts, Value: 1 },
      ]
    }));
  } catch (e: any) {
    logger.warn('Failed to emit StepSuccess metric', e?.message || e);
  }
}

/** Emit a StepDurationMillis for timing a step */
export async function emitStepDuration(step: PipelineStep, durationMs: number, component?: string, extraDims?: { Name: string; Value: string }[]): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const namespace = getNamespace('ops');
    const dims = baseDimensions([
      { Name: 'Step', Value: step },
      ...(component ? [{ Name: 'Component', Value: component }] : []),
      ...(extraDims || [])
    ]);
    const ts = new Date();
    await client.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        { MetricName: 'StepDurationMillis', Dimensions: dims, Timestamp: ts, Value: Math.max(0, durationMs) },
      ]
    }));
  } catch (e: any) {
    logger.warn('Failed to emit StepDurationMillis metric', e?.message || e);
  }
}

/** Convenience: wrap an async step to emit duration + success/failure automatically */
export async function withStepMetric<T>(step: PipelineStep, fn: () => Promise<T>, component?: string, extraDims?: { Name: string; Value: string }[]): Promise<T> {
  const start = Date.now();
  try {
    const res = await fn();
    emitStepSuccess(step, component, extraDims).catch(() => {});
    emitStepDuration(step, Date.now() - start, component, extraDims).catch(() => {});
    return res;
  } catch (e: any) {
    const name = e?.code || e?.name || (typeof e === 'string' ? e : 'Error');
    emitStepFailure(step, String(name), component, extraDims).catch(() => {});
    emitStepDuration(step, Date.now() - start, component, extraDims).catch(() => {});
    throw e;
  }
}

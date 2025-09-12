# CloudWatch metrics, alarms, and codes

This project publishes CloudWatch Metrics (not Logs) to track pipeline health and failures. This doc explains:

- What metrics we emit and when
- Namespaces, dimensions, and environment toggles
- Step/error/stage “codes” used as dimension values
- What alarms exist and how they’re configured

See code: `src/lib/cloudwatchMetrics.ts` and alarms template: `alarms/cloudwatch-alarms.json`.

## Emission client and namespaces

- Metrics client is created lazily via AWS SDK v3 `CloudWatchClient`.
- Region: `AWS_REGION` (default `us-east-1` in the metrics helper).
- Global toggle: set `VALIDATION_METRICS_ENABLED=false` to disable all metric emissions (both ops and validation paths use this toggle).
- Namespaces:
  - Validation: `SPICE/VideoPipelineValidation` (override with `VALIDATION_METRIC_NAMESPACE`)
  - Ops: `SPICE/VideoPipelineOps` (override with `OP_METRIC_NAMESPACE`)

## Base dimensions

Every metric gets at least:

- Environment: `Environment = NODE_ENV` (default `dev`)

Functions then add context-specific dimensions (Step, Stage, ErrorType, Component, Flow, etc.).

## Metrics we emit

Validation namespace (`SPICE/VideoPipelineValidation`):

- YtdlpFatalError
  - Value: 1 per emission
  - Dims: `Environment`, `Stage=yt_dlp`, `ErrorType` (first 50 chars), `Flow` (`existing_episode` or `new_or_legacy`)
  - Source: `emitYtdlpErrorMetric(errorType?, isExistingEpisode?)`

- PostProcessValidationFailed
  - Value: 1 if validation failed, else 0
  - Dims: `Environment`, `Stage` (default `post_process`)
  - Source: `emitValidationMetric({ success, ... })`

- PostProcessValidationErrors
  - Value: integer error count
  - Dims: `Environment`, `Stage` (default `post_process`)

- PostProcessValidationWarnings
  - Value: integer warning count (optional)
  - Dims: `Environment`, `Stage` (default `post_process`)

- IntegrityScanErrors | IntegrityScanWarnings | IntegrityScanTotal | IntegrityScanFailed
  - Values: integers, plus `IntegrityScanFailed` is 1 when errors > 0
  - Dims: `Environment`, `Stage=integrity_scan`
  - Source: `emitIntegrityScanMetric({ scanned, errors, warnings })`

Ops namespace (`SPICE/VideoPipelineOps`):

- StepFailure
  - Value: 1 per failure
  - Dims: `Environment`, `Step`, optional `Component`, optional `ErrorName` (first 64 chars), and any extraDims provided
  - Source: `emitStepFailure(step, errorName?, component?, extraDims?)`

- StepSuccess
  - Value: 1 per success
  - Dims: `Environment`, `Step`, optional `Component`, extraDims
  - Source: `emitStepSuccess(step, component?, extraDims?)`

- StepDurationMillis
  - Value: duration in milliseconds (>= 0)
  - Dims: `Environment`, `Step`, optional `Component`, extraDims
  - Source: `emitStepDuration(step, durationMs, component?, extraDims?)`

Convenience wrapper:

- `withStepMetric(step, asyncFn, component?, extraDims?)`
  - Measures and emits StepDurationMillis and StepSuccess/StepFailure automatically around your async step.

## Codes used in dimensions

- Step (union type in code):
  - `sqs_handle_message`, `metadata_fetch`, `audio_download`, `video_download`, `merge`, `s3_upload_audio`,
    `s3_upload_video`, `s3_download`, `rds_store_episode`, `rds_update_episode`, `hls_render`, `transcription_enqueue`,
    `validation`, `guest_extraction`, `task_protection`, `poller`, `pipeline`, `unhandled`

- Stage:
  - Common values: `post_process`, `integrity_scan`, `yt_dlp`

- ErrorType (yt-dlp fatal): short category string (first 50 chars kept)
  - Examples: `metadata`, `network`, `generic`

- ErrorName (step failures): taken from exception `e.code` or `e.name` (first 64 chars kept)

- Component (optional): caller-defined string to identify sub-component

- Flow (yt-dlp fatal): `existing_episode` or `new_or_legacy`

## Alarms defined (alarms/cloudwatch-alarms.json)

Parameters:

- NamespaceOps (default `SPICE/VideoPipelineOps`)
- NamespaceValidation (default `SPICE/VideoPipelineValidation`)
- Environment (default `dev`)
- AlarmTopicArn (SNS topic to notify)

Alarms:

- YtdlpFatalAlarm
  - AlarmName: `${Environment}-YtdlpFatalError`
  - Namespace: Validation
  - MetricName: `YtdlpFatalError`
  - Dimensions: `Environment`
  - Threshold: Sum ≥ 1
  - Period: 60s, EvaluationPeriods: 1, DatapointsToAlarm: 1
  - TreatMissingData: `notBreaching`
  - Actions: `AlarmActions` and `OKActions` → `AlarmTopicArn`

- StepFailureAlarm
  - AlarmName: `${Environment}-PipelineStepFailure`
  - Namespace: Ops
  - MetricName: `StepFailure`
  - Dimensions: `Environment`
  - Threshold: Sum ≥ 1
  - Period: 60s, EvaluationPeriods: 1, DatapointsToAlarm: 1
  - TreatMissingData: `notBreaching`
  - Actions: `AlarmActions` and `OKActions` → `AlarmTopicArn`

- ValidationFailedAlarm
  - AlarmName: `${Environment}-PostProcessValidationFailed`
  - Namespace: Validation
  - MetricName: `PostProcessValidationFailed`
  - Dimensions: `Environment`, `Stage=post_process`
  - Threshold: Sum ≥ 1
  - Period: 300s, EvaluationPeriods: 1, DatapointsToAlarm: 1
  - TreatMissingData: `notBreaching`
  - Actions: `AlarmActions` and `OKActions` → `AlarmTopicArn`

Notes:

- Alarms filter only on `Environment` (and for the post-process validation alarm, also `Stage=post_process`). If you add more dimensions to emission, ensure alarms match their dimension filters or they won’t see your data.
- TreatMissingData `notBreaching` avoids flapping when no data is emitted.

## Environment variables

- `VALIDATION_METRICS_ENABLED`: when set to `false`, disables all metric emission in our helper.
- `VALIDATION_METRIC_NAMESPACE`: overrides validation namespace.
- `OP_METRIC_NAMESPACE`: overrides ops namespace.
- `AWS_REGION`: region for the CloudWatch client (default `us-east-1` in this helper).
- `NODE_ENV`: used as the `Environment` dimension value.

Tip: If you also have other components sending metrics or logs, keep namespaces consistent across services or adjust alarms accordingly.

## Usage examples

Wrap a step with metrics:

```ts
import { withStepMetric } from './src/lib/cloudwatchMetrics';

await withStepMetric('video_download', async () => {
  // your work here
});
```

Emit a yt-dlp fatal error metric:

```ts
import { emitYtdlpErrorMetric } from './src/lib/cloudwatchMetrics';

await emitYtdlpErrorMetric('network', true); // existing episode path
```

## See also

- Alarms template: `alarms/cloudwatch-alarms.json`
- End-to-end flow: `docs/Guide_to_understanding_to_process.md`
- ECS runtime behavior: `docs/ECS_OPTIMIZATIONS.md`
- Validation internals: `docs/MP4_TO_HLS.md`

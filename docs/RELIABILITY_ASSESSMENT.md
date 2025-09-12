# Reliability assessment: what can go wrong and how we mitigate it

This document summarizes likely failure modes across the pipeline, what we already do to mitigate them, how we detect issues (metrics/alarms), and recommended hardening steps.

See also: `docs/AWS_CLOUDWATCH.md`, `docs/AWS_S3.md`, `docs/DB_operations_and_props.md`, `docs/CONCURRENCY_SETUP.md`, `docs/MP4_TO_HLS.md`, `docs/YTDLP_props.md`.

## Top failure areas and symptoms

1. Ingress and job orchestration (SQS/poller)

- Malformed SQS message bodies or missing fields
- Duplicate messages / re-delivery causing duplicate work
- Poller crash or inability to ack → visibility timeouts and reprocessing
- Credentials/region mismatch → poller cannot read queue

1. Network and content fetching (yt-dlp)

- Upstream extractor changes, site layout changes → metadata or download failures
- Rate limits (HTTP 429) or transient 5xx
- Cookies missing/expired, geo/age restrictions, paywalled content
- Local binary missing or not executable (yt-dlp/ffmpeg) or plugin path invalid
- Disk space exhaustion during large downloads

1. Media processing (ffmpeg/HLS)

- ffmpeg failures (codec mismatch, corrupt input, insufficient CPU)
- Generated HLS playlists missing variants or invalid master
- Duration/bitrate inconsistencies; very long or zero durations

1. Storage (S3)

- Auth errors (AccessDenied), bad keys/buckets/region mismatch
- Multipart upload part failures; AbortError; slow or saturated throughput
- Object existence checks returning AccessDenied vs NotFound
- Presigned URLs not working due to region or time skew

1. Database (RDS/PostgreSQL)

- Connection pool exhaustion; connection timeouts
- Lock contention / deadlocks / row lock not available
- Duplicate detection races; schema drift vs. code expectations
- Slow queries under load

1. Compute platform (ECS/Fargate)

- Spot interruption; scale-in during active jobs
- Task metadata discovery failures; region/env mismatch
- OOM due to concurrency or large merges; low ephemeral disk

1. Concurrency and backpressure

- Over-parallelization causing throttling, IO wait, or DB lock storms
- Under-parallelization underutilizing capacity
- Mis-set `GREEDY_PER_JOB` leading to long queue times or unfairness

1. Validation and observability

- Validation not run or run without S3 verification → silent missing artifacts
- Metrics disabled globally → alarms never fire
- Alarms filtered on unexpected dimensions → no data seen
- Log level too low/high, missing context

1. Cleanup and capacity leaks

- Temp/download directories not cleaned; disk fills over time
- Orphaned metadata files left between runs

## What mitigations exist today (code-level)

- Concurrency/backpressure: process-local semaphores per subsystem (`disk`, `s3`, `db`, `http`) with environment overrides and core detection; see `docs/CONCURRENCY_SETUP.md`.
- Retries: centralized `withRetry()` plus S3 retry wrapper (skips non-retryable auth/validation errors).
- RDS transactions: `READ COMMITTED` isolation; `SELECT … FOR UPDATE NOWAIT` to avoid long waits; automatic retries for transient lock/serialization conflicts; post-commit validation of updates; see `docs/DB_operations_and_props.md`.
- Duplicate prevention: in-transaction duplicate checks by `(episodeTitle, channelId)` and `youtubeVideoId` with row locks.
- Input sanitation: `sanitizeText()` for DB, slug builders for S3 keys.
- Validation: `IntegrityValidator` checks field presence, consistency (`master_m3u8` with `videoLocation`), duration sanity, and optional HEAD checks for referenced S3 objects; emits validation metrics.
- HLS generation: validated outputs with master playlist fallback builder when needed; see `docs/MP4_TO_HLS.md`.
- CloudWatch metrics: step successes/failures/durations (Ops), yt-dlp fatal, validation and integrity scan metrics (Validation); see `docs/AWS_CLOUDWATCH.md`.
- ECS protection: task protection management on on-demand; no-op on spot; periodic renew; drain-and-shutdown on yt-dlp fatal.

## Detection and alarms (what we will see)

- Ops namespace
  - `StepFailure` spikes (dims: Step, Component, ErrorName) → S3 upload/download/RDS write/merge/yt-dlp step errors
  - `StepDurationMillis` drifts → saturation, throttling, or external slowness
- Validation namespace
  - `YtdlpFatalError` alarm (1-minute, Sum ≥ 1)
  - `PostProcessValidationFailed` alarm (5-minute, Sum ≥ 1, Stage=post_process)
  - `IntegrityScan*` metrics (errors, warnings, total, failed) for periodic audits

Caveat: the helper uses `VALIDATION_METRICS_ENABLED=false` to disable the entire metrics client, affecting both Ops and Validation metrics.

## Likely root causes by area and how to handle

1. yt-dlp failures

- Check `YtdlpFatalError` and StepFailure with `Step=video_download` or `metadata_fetch`; inspect `ErrorType`/`ErrorName` dims
- Validate cookies file existence and freshness; confirm plugins configured
- Reduce `YTDLP_CONNECTIONS` when remote throttles; ensure bandwidth
- Confirm binaries in `./bin`; rebuild image if missing

1. FFmpeg/HLS issues

- Validate input file integrity; retry merge (`disk_ffmpeg_merge`)
- Lower parallelism if CPU-bound (`DISK_CONCURRENCY=1`, keep `GREEDY_PER_JOB=true`)
- Rebuild master via `writeMasterM3U8FromRenditions` when variants exist but master missing

1. S3 upload/download

- Inspect `StepFailure` with `Component=s3`; check bucket/region/policy
- Increase part size/queue (`S3_UPLOAD_PART_SIZE_MB`, `S3_UPLOAD_QUEUE_SIZE`) if underutilized; reduce if thrashing
- Watch for `AbortError` (handled specially) and AccessDenied (non-retryable)

1. RDS contention and errors

- NOWAIT lock failures → normal retry path; if persistent, reduce `DB_MAX_INFLIGHT`
- Deadlocks/serialization errors → handled by `executeWithRetry`; verify index/constraints
- If validation of updates fails, the code retries with backoff; inspect logs for mismatched fields

1. ECS/Fargate platform

- For on-demand: ensure task protection is renewing; for spot, expect interruptions and requeue work
- Ensure ephemeral storage and memory are sufficient; reduce `DISK_CONCURRENCY` or job fan-out

1. Concurrency misconfiguration

- Use `logCpuConfiguration()` to verify detected cores and active limits
- Start from defaults; raise limits incrementally with metrics watching

1. Validation gaps

- Run `IntegrityValidator` with `verifyS3=true` for audits; consider scheduling it
- Add alarms on IntegrityScanFailed if needed

## Recommended hardening steps (low-risk)

- Add an alarm on `IntegrityScanFailed` (Validation namespace; Sum ≥ 1 over 15m)
- Emit a metric on `retry_exhausted` per label and alarm when sustained
- Add a custom metric for disk free space and alarm (container ephemeral storage)
- Ensure metrics client isn’t globally disabled in production (avoid `VALIDATION_METRICS_ENABLED=false`)
- Add bucket policy checks to CI, verify region and public access expectations
- Validate cookies file presence on startup; log a clear warning with path
- Add optional checksum/ETag verification post-upload for critical artifacts
- Cap `YTDLP_CONNECTIONS` in production to a safe bound (e.g., ≤ cores) and observe

## Quick operator checklist

- Are Ops and Validation metrics flowing in the expected namespace and region?
- Any active alarms? Check dimensions (Environment, Stage/Step) to scope
- Disk within safe headroom? CPU throttling or OOM events present?
- Recent `StepFailure` spikes by Step/Component? Top `ErrorName`?
- `PostProcessValidationFailed` firing? Inspect latest run and rerun validation
- S3 buckets and prefixes correct and reachable from the task environment?

## SLO ideas (baseline)

- Post-process validation failures: < 1% of episodes per day
- Step failures (Ops) over 1h: Sum < N where N reflects expected transient noise
- Median upload duration stable within ±25% week-over-week; investigate drifts

---

By tightening concurrency, watching the three core alarms, and running periodic integrity scans with S3 verification, most silent or latent failures become visible quickly and are bounded by retries/backpressure.

# Concurrency and parallelism in the pipeline

This doc explains how we size and coordinate concurrent work across CPU, disk, network, and database; how contention is controlled; and how to tune via environment variables.

Sources: `src/lib/utils/concurrency.ts`, plus usage in S3, yt-dlp/FFmpeg, and RDS services.

## Goals

- Maximize throughput without starving resources or thrashing the container
- Separate CPU-bound and I/O-bound limits
- Provide process-local backpressure with semaphores
- Keep database writes serialized enough to avoid lock storms
- Offer simple env overrides for ECS/Fargate and local runs

## How effective concurrency is computed

We detect usable cores in containers via multiple signals (first match wins):

1. Environment override: `EFFECTIVE_CPU_CORES`
1. cgroup cpuset limits: `/sys/fs/cgroup/**/cpuset.cpus`
1. cgroup CPU quota: `/sys/fs/cgroup/cpu.max` (v2) or `cpu.cfs_quota_us`/`cpu.cfs_period_us` (v1)
1. Node’s physical CPU count as a last resort

From that we derive defaults:

- CPU-bound default: `computeDefaultConcurrency('cpu') = max(1, cores)`
- I/O-bound default: `computeDefaultConcurrency('io') = max(4, cores * 2)`

You can see the detected values at runtime via `logCpuConfiguration()` which prints:

- Physical cores, cpuset and quota limits, effective cores
- Derived CPU and I/O concurrency
- Greedy per-job mode state
- Current semaphore limits per subsystem

## Global semaphores (process-local backpressure)

We expose one semaphore per major subsystem:

- S3 operations: `s3Semaphore`
- HTTP operations: `httpSemaphore`
- Disk-heavy operations (yt-dlp/ffmpeg/temp IO): `diskSemaphore`
- Database operations (writes): `dbSemaphore`

Defaults (can be overridden; see Env section):

- `s3Semaphore`: `getConcurrencyFromEnv('S3_UPLOAD_CONCURRENCY', computeDefaultConcurrency('io'))`
- `httpSemaphore`: `getConcurrencyFromEnv('HTTP_CONCURRENCY', computeDefaultConcurrency('io'))`
- `diskSemaphore`: `getConcurrencyFromEnv('DISK_CONCURRENCY', GREEDY_PER_JOB ? 1 : computeDefaultConcurrency('cpu'))`
- `dbSemaphore`: `getConcurrencyFromEnv('DB_MAX_INFLIGHT', Math.max(2, computeDefaultConcurrency('cpu')))`

The helper `withSemaphore(sem, label, fn)` runs `fn` under the semaphore and records lightweight metrics:

- Gauges: `<label>_in_flight`, `<label>_queue_depth`
- Counters: `<label>_success_total`, `<label>_failure_total`, `<label>_latency_ms_sum`

For batch work, `mapWithConcurrency(items, sem, label, mapper)` binds array processing to a semaphore.

## Greedy per-job mode

- `GREEDY_PER_JOB` (defaults to true unless explicitly set to `false`) sets `diskSemaphore` to 1.
- Rationale: heavy ffmpeg/yt-dlp tasks scale with CPU; serializing them lets a single job consume all cores to finish quickly instead of time-slicing many.
- Override with `DISK_CONCURRENCY` when you want to allow parallel heavy jobs.

## Retries and backoff

`withRetry(fn, { attempts, baseDelayMs, backoffMultiplier, isRetryable, label })` centralizes retry behavior:

- Defaults: attempts from `RETRY_ATTEMPTS` (or 3), base delay from `RETRY_BASE_DELAY_MS` (or 500ms), multiplier 2
- Emits counters: `retry_attempts`, `retry_success_after_attempt`, `retry_exhausted`

S3 service has its own retry wrapper that avoids re-trying auth/validation errors.

## Where concurrency limits are applied

- yt-dlp downloads
  - Network fan-out: `-N <connections>` auto-tuned to CPU cores (or `YTDLP_CONNECTIONS`)
  - Disk/CPU guard: downloads and merges execute under `diskSemaphore` with labels `disk_ytdlp`, `disk_ffmpeg_merge`
- FFmpeg HLS rendering
  - Runs under `diskSemaphore` with label `disk_ffmpeg_hls`
- S3
  - HEAD, PUT, multipart uploads execute under `s3Semaphore` with labels `s3_head`, `s3_put`, `s3_upload`
  - Ranged downloads use adjustable part sizes and concurrency (see Env); step-level CW metrics are emitted
- RDS
  - All writes run under `dbSemaphore` with label `db_write` plus transaction-level retries

Note: An additional `httpSemaphore` is available for general HTTP workloads if/when needed.

## Environment variables (tuning)

- Global fallback for semaphores
  - `SEMAPHORE_MAX_CONCURRENCY`: default for any per-subsystem limit not explicitly set
- CPU sizing
  - `EFFECTIVE_CPU_CORES`: explicit core count to use (bypasses cgroup detection)
  - `GREEDY_PER_JOB`/`GREEDY_MODE`: `true`/`false` (default true)
- Subsystem limits
  - `DISK_CONCURRENCY`: overrides `diskSemaphore`
  - `S3_UPLOAD_CONCURRENCY`: overrides `s3Semaphore`
  - `HTTP_CONCURRENCY`: overrides `httpSemaphore`
  - `DB_MAX_INFLIGHT`: overrides `dbSemaphore`
- yt-dlp
  - `YTDLP_CONNECTIONS`: overrides `-N` connections
- S3 transfer tuning
  - Upload: `S3_UPLOAD_PART_SIZE_MB` (default 32), `S3_UPLOAD_QUEUE_SIZE` (default scales with IO, cap 16)
  - Download: `S3_DOWNLOAD_PART_SIZE_MB` (default 32), `S3_DOWNLOAD_CONCURRENCY` (default scales with IO)
- Retry defaults
  - `RETRY_ATTEMPTS` (default 3), `RETRY_BASE_DELAY_MS` (default 500), multiplier fixed at 2 unless provided in code

## Practical guidance

- For CPU-heavy workloads on small tasks: set `GREEDY_PER_JOB=true` (default) so one job can finish quickly.
- To increase parallelism across jobs: raise `DISK_CONCURRENCY` cautiously; monitor CPU steal and IO wait.
- On ECS/Fargate with vCPU limits: set `EFFECTIVE_CPU_CORES` if cgroup detection doesn’t reflect actual limits.
- For S3 large files: increase `S3_UPLOAD_PART_SIZE_MB` and `S3_UPLOAD_QUEUE_SIZE` only if network and disk can keep up.
- To reduce DB contention: lower `DB_MAX_INFLIGHT` (defaults to at least 2) and rely on the built-in retries.

## See also

- RDS transactions and locking: `docs/DB_operations_and_props.md`
- AWS S3 usage and validation: `docs/AWS_S3.md`
- CloudWatch metrics and alarms: `docs/AWS_CLOUDWATCH.md`

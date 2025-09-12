import os from 'os';
import fs from 'fs';

// Simple async semaphore implementation
export class Semaphore {
  private max: number;
  private queue: Array<() => void> = [];
  private inFlight = 0;

  constructor(max: number) {
    this.max = Math.max(1, max || 1);
  }

  get capacity() { return this.max; }
  get inFlightCount() { return this.inFlight; }
  get queueDepth() { return this.queue.length; }

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.inFlight < this.max) {
          this.inFlight++;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release() {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export type RetryOptions = {
  attempts?: number; // total attempts (including first)
  baseDelayMs?: number;
  backoffMultiplier?: number;
  isRetryable?: (err: any) => boolean;
  onAttempt?: (info: { attempt: number; attempts: number; delay: number; error: any; label?: string }) => void;
  label?: string;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? parseInt(process.env.RETRY_ATTEMPTS || '3', 10));
  const base = Math.max(1, opts.baseDelayMs ?? parseInt(process.env.RETRY_BASE_DELAY_MS || '500', 10));
  const mult = Math.max(1, opts.backoffMultiplier ?? 2);
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fn();
      if (attempt > 1) metrics.increment('retry_success_after_attempt', 1, opts.label);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) break;
      const delay = base * Math.pow(mult, attempt - 1);
      opts.onAttempt?.({ attempt, attempts, delay, error: err, label: opts.label });
      metrics.increment('retry_attempts', 1, opts.label);
      await sleep(delay);
    }
  }
  metrics.increment('retry_exhausted', 1, opts.label);
  throw lastErr;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// CPU detection aware of cgroups (Linux containers)
function parseCpuset(cpuset: string): number {
  // Example formats: "0-3", "0,2,4-6", "1"; may include whitespace
  const parts = cpuset.split(',').map(s => s.trim()).filter(Boolean);
  let count = 0;
  for (const p of parts) {
    if (p.includes('-')) {
      const [startStr, endStr] = p.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        count += (end - start + 1);
      }
    } else {
      const n = parseInt(p, 10);
      if (Number.isFinite(n)) count += 1;
    }
  }
  return Math.max(0, count);
}

function detectCpusetCount(): number | undefined {
  try {
    // cgroup v2 unified hierarchy often exposes cpuset at /sys/fs/cgroup/cpuset.cpus
    const candidates = [
      '/sys/fs/cgroup/cpuset.cpus',
      '/sys/fs/cgroup/cpuset/cpuset.cpus', // cgroup v1 typical path
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8').trim();
        const cnt = parseCpuset(content);
        if (cnt > 0) return cnt;
      }
    }
  } catch {}
  return undefined;
}

function detectCpuQuota(): number | undefined {
  try {
    // cgroup v2: /sys/fs/cgroup/cpu.max => "<quota> <period>" or "max"
    const cpuMaxPath = '/sys/fs/cgroup/cpu.max';
    if (fs.existsSync(cpuMaxPath)) {
      const content = fs.readFileSync(cpuMaxPath, 'utf8').trim();
      const [quotaStr, periodStr] = content.split(' ');
      if (quotaStr !== 'max') {
        const quota = parseInt(quotaStr, 10);
        const period = parseInt(periodStr, 10) || 100000;
        if (quota > 0 && period > 0) {
          const cpus = Math.max(1, Math.floor(quota / period));
          return cpus;
        }
      }
    }

    // cgroup v1: cpu.cfs_quota_us and cpu.cfs_period_us
    const v1Candidates = [
      { q: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us', p: '/sys/fs/cgroup/cpu/cpu.cfs_period_us' },
      { q: '/sys/fs/cgroup/cpuacct/cpu.cfs_quota_us', p: '/sys/fs/cgroup/cpuacct/cpu.cfs_period_us' },
      { q: '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us', p: '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us' },
    ];
    for (const { q, p } of v1Candidates) {
      if (fs.existsSync(q) && fs.existsSync(p)) {
        const quota = parseInt(fs.readFileSync(q, 'utf8').trim(), 10);
        const period = parseInt(fs.readFileSync(p, 'utf8').trim(), 10) || 100000;
        if (Number.isFinite(quota) && quota > 0 && period > 0) {
          const cpus = Math.max(1, Math.floor(quota / period));
          return cpus;
        }
      }
    }
  } catch {}
  return undefined;
}

function defaultCpuCount(): number {
  return os.cpus()?.length || 2;
}

export function computeDefaultConcurrency(kind: 'cpu' | 'io'): number {
  // Allow explicit override via env (useful on ECS/Fargate)
  const envOverride = (() => {
    const v = parseInt(process.env.EFFECTIVE_CPU_CORES || '', 10);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  })();

  // Prefer explicit override, then cpuset (more precise), then quota, else physical cores
  const cpusetCpus = detectCpusetCount();
  const quotaCpus = detectCpuQuota();
  const cores = envOverride ?? cpusetCpus ?? quotaCpus ?? defaultCpuCount();
  if (kind === 'cpu') return Math.max(1, cores);
  // For I/O, allow higher fan-out
  return Math.max(4, cores * 2);
}

/**
 * Log current CPU utilization configuration for debugging and monitoring
 */
export function logCpuConfiguration(): void {
  const cpusetCpus = detectCpusetCount();
  const quotaCpus = detectCpuQuota();
  const physicalCores = defaultCpuCount();
  const envOverride = (() => {
    const v = parseInt(process.env.EFFECTIVE_CPU_CORES || '', 10);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  })();
  const effectiveCores = envOverride ?? cpusetCpus ?? quotaCpus ?? physicalCores;
  const cpuConcurrency = computeDefaultConcurrency('cpu');
  const ioConcurrency = computeDefaultConcurrency('io');

  console.log('🖥️ CPU Utilization Configuration:');
  console.log(`  Physical CPU cores: ${physicalCores}`);
  if (envOverride) {
    console.log(`  Env override (EFFECTIVE_CPU_CORES): ${envOverride}`);
  }
  if (cpusetCpus) {
    console.log(`  CPUSet limit: ${cpusetCpus} cores`);
  }
  if (quotaCpus) {
    console.log(`  Container CPU limit: ${quotaCpus} cores (cgroups detected)`);
  }
  console.log(`  Effective CPU cores: ${effectiveCores}`);
  console.log(`  CPU-bound concurrency: ${cpuConcurrency}`);
  console.log(`  I/O-bound concurrency: ${ioConcurrency}`);
  console.log(`  Greedy per-job mode: ${GREEDY_PER_JOB ? 'ENABLED' : 'disabled'}`);
  
  console.log('📊 Active Semaphore Limits:');
  console.log(`  S3 operations: ${s3Concurrency}`);
  console.log(`  HTTP operations: ${httpConcurrency}`);
  console.log(`  Disk operations: ${diskConcurrency}`);
  console.log(`  Database operations: ${dbInflight}`);
}

export function getConcurrencyFromEnv(envVar: string, fallback: number): number {
  const globalDefault = parseInt(process.env.SEMAPHORE_MAX_CONCURRENCY || '', 10);
  const specific = parseInt(process.env[envVar as any] || '', 10);
  const chosen = Number.isFinite(specific) && specific > 0
    ? specific
    : (Number.isFinite(globalDefault) && globalDefault > 0 ? globalDefault : fallback);
  return Math.max(1, chosen);
}

// Greedy per-job mode: when enabled, we serialize CPU-bound heavy work (like ffmpeg/yt-dlp)
// so a single job can fully utilize all cores/threads. Override with DISK_CONCURRENCY env.
const GREEDY_PER_JOB = (process.env.GREEDY_PER_JOB ?? process.env.GREEDY_MODE ?? 'true').toLowerCase() !== 'false';

// Global semaphores for subsystems
const s3Concurrency = getConcurrencyFromEnv('S3_UPLOAD_CONCURRENCY', computeDefaultConcurrency('io'));
const httpConcurrency = getConcurrencyFromEnv('HTTP_CONCURRENCY', computeDefaultConcurrency('io'));
const diskConcurrency = getConcurrencyFromEnv('DISK_CONCURRENCY', GREEDY_PER_JOB ? 1 : computeDefaultConcurrency('cpu'));
const dbInflight = getConcurrencyFromEnv('DB_MAX_INFLIGHT', Math.max(2, computeDefaultConcurrency('cpu')));

export const s3Semaphore = new Semaphore(s3Concurrency);
export const httpSemaphore = new Semaphore(httpConcurrency);
export const diskSemaphore = new Semaphore(diskConcurrency);
export const dbSemaphore = new Semaphore(dbInflight);

export function isGreedyPerJob(): boolean { return GREEDY_PER_JOB; }

/**
 * Lightweight signal to detect we're likely running on ECS
 */
export function isRunningInEcs(): boolean {
  return Boolean(process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI);
}

// Lightweight in-memory metrics
type CounterKey = string;
class Metrics {
  private counters = new Map<CounterKey, number>();
  private gauges = new Map<string, number>();

  increment(name: string, val = 1, label?: string) {
    const key = label ? `${name}{label=${label}}` : name;
    this.counters.set(key, (this.counters.get(key) || 0) + val);
  }

  gauge(name: string, val: number, label?: string) {
    const key = label ? `${name}{label=${label}}` : name;
    this.gauges.set(key, val);
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges)
    } as { counters: Record<string, number>; gauges: Record<string, number> };
  }
}

export const metrics = new Metrics();

export async function withSemaphore<T>(sem: Semaphore, label: string, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  metrics.gauge(`${label}_in_flight`, sem.inFlightCount, label);
  metrics.gauge(`${label}_queue_depth`, sem.queueDepth, label);
  const start = Date.now();
  try {
    const res = await fn();
    metrics.increment(`${label}_success_total`, 1);
    return res;
  } catch (e) {
    metrics.increment(`${label}_failure_total`, 1);
    throw e;
  } finally {
    const dur = Date.now() - start;
    metrics.increment(`${label}_latency_ms_sum`, dur);
    release();
    metrics.gauge(`${label}_in_flight`, sem.inFlightCount, label);
    metrics.gauge(`${label}_queue_depth`, sem.queueDepth, label);
  }
}

// Small helper to process an array with bounded concurrency
export async function mapWithConcurrency<T, R>(items: T[], sem: Semaphore, label: string, mapper: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  await Promise.all(items.map((item, idx) =>
    withSemaphore(sem, label, async () => {
      const r = await mapper(item, idx);
      results[idx] = r;
    })
  ));
  return results;
}

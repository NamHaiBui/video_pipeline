#!/usr/bin/env tsx

/**
 * Auto-tune script: proposes environment values to maximize CPU utilization
 * for a desired number of concurrent jobs on a given CPU budget.
 *
 * Usage examples:
 *  - tsx scripts/auto-tune.ts --jobs 1
 *  - tsx scripts/auto-tune.ts --jobs 2 --preset fast --top 1080 --format json
 *  - tsx scripts/auto-tune.ts --jobs 1 --write-env .env.autotune
 */

import fs from 'fs';
import path from 'path';
import { computeDefaultConcurrency, logCpuConfiguration } from '../src/lib/utils/concurrency.js';

type Args = {
  jobs: number;
  preset: 'veryfast' | 'fast' | 'medium';
  top: 1080 | 720;
  format: 'lines' | 'json';
  writeEnv?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[i + 1] : undefined);
    if (a === '--jobs') { args.jobs = Math.max(1, parseInt(next() || '1', 10)); i++; }
    else if (a === '--preset') {
      const p = (next() || 'veryfast').toLowerCase(); i++;
      args.preset = (['veryfast', 'fast', 'medium'] as const).includes(p as any) ? (p as any) : 'veryfast';
    }
    else if (a === '--top') {
      const t = parseInt(next() || '1080', 10); i++;
      args.top = (t === 720 ? 720 : 1080) as any;
    }
    else if (a === '--format') {
      const f = (next() || 'lines').toLowerCase(); i++;
      args.format = (f === 'json' ? 'json' : 'lines');
    }
    else if (a === '--write-env') {
      args.writeEnv = next(); i++;
    }
  }
  return {
    jobs: args.jobs ?? 1,
    preset: args.preset ?? 'veryfast',
    top: args.top ?? 1080,
    format: args.format ?? 'lines',
    writeEnv: args.writeEnv,
  };
}

function allocateThreads(total: number, defs: string[]): Record<string, number> {
  // Weight by pixel area
  const toPx = (def: string) => {
    switch (def) {
      case '1080p': return 1920 * 1080;
      case '720p': return 1280 * 720;
      case '480p': return 854 * 480;
      case '360p': return 640 * 360;
      default: return 1;
    }
  };
  const px = defs.map(toPx);
  const totalPx = px.reduce((a, b) => a + b, 0) || 1;
  // Ensure at least 1 for the largest, allow 0 for the smallest if budget is tiny
  const shares = px.map(v => v / totalPx);
  let remaining = Math.max(0, total);
  const out = defs.map(() => 0);
  // Floor allocation
  const floors = shares.map(s => Math.floor(s * remaining));
  let used = floors.reduce((a, b) => a + b, 0);
  remaining -= used;
  for (let i = 0; i < defs.length; i++) out[i] = floors[i];
  // Hand out leftovers to biggest first
  const order = shares.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s).map(o => o.i);
  let idx = 0;
  while (remaining > 0 && order.length > 0) {
    out[order[idx % order.length]] += 1;
    idx++; remaining--;
  }
  // Ensure the top definition gets at least 1 thread if budget > 0
  if (total > 0 && out[order[0]] === 0) out[order[0]] = 1;
  const result: Record<string, number> = {};
  defs.forEach((d, i) => { result[d] = out[i]; });
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const totalCpu = computeDefaultConcurrency('cpu');
  const ioConc = computeDefaultConcurrency('io');

  // Jobs and per-job core budget
  const jobs = Math.max(1, Math.min(args.jobs, totalCpu));
  const perJobCores = Math.max(1, Math.floor(totalCpu / jobs));

  // Recommend values
  const greedy = jobs === 1;
  const diskConcurrency = greedy ? 1 : Math.min(jobs, perJobCores);
  const ytdlp = Math.max(3, perJobCores);
  const ffmpegThreads = perJobCores;
  const hlsEncTotal = Math.max(1, perJobCores - 1); // keep 1 for filters/muxing
  const defs = args.top === 1080 ? ['1080p', '720p', '480p', '360p'] : ['720p', '480p', '360p'];
  const hlsSplit = allocateThreads(hlsEncTotal, defs);
  const hlsByDef = Object.entries(hlsSplit).map(([k, v]) => `${k}=${v}`).join(',');
  const s3Conc = Math.min(16, ioConc);

  const rec = {
    // Job control
    MAX_CONCURRENT_JOBS: String(jobs),
    GREEDY_PER_JOB: String(greedy),
    DISK_CONCURRENCY: String(diskConcurrency),
    // CPU budget
    EFFECTIVE_CPU_CORES: String(totalCpu),
    // Download/encode
    YTDLP_CONNECTIONS: String(ytdlp),
    FFMPEG_THREADS: String(ffmpegThreads),
    HLS_X264_PRESET: args.preset,
    HLS_ENCODER_THREADS_TOTAL: String(hlsEncTotal),
    HLS_THREADS_BY_DEF: hlsByDef,
    // I/O
    S3_UPLOAD_CONCURRENCY: String(s3Conc),
    S3_DOWNLOAD_CONCURRENCY: String(s3Conc),
    HTTP_CONCURRENCY: String(s3Conc),
  } as Record<string, string>;

  // Output
  console.log('🔧 Auto-tune proposal');
  logCpuConfiguration();
  console.log('—'.repeat(40));

  if (args.format === 'json') {
    console.log(JSON.stringify(rec, null, 2));
  } else {
    Object.entries(rec).forEach(([k, v]) => console.log(`${k}=${v}`));
  }

  if (args.writeEnv) {
    const lines = Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    const filePath = path.resolve(process.cwd(), args.writeEnv);
    fs.writeFileSync(filePath, lines, 'utf-8');
    console.log(`\n📝 Wrote recommendations to ${filePath}`);
  }
}

main();

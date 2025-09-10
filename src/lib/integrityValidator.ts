import { createRDSServiceFromEnv, RDSService, EpisodeRecord } from './rdsService.js';
import { createS3ServiceFromEnv, S3Service } from './s3Service.js';
import { logger } from './utils/logger.js';
import { emitIntegrityScanMetric } from './cloudwatchMetrics.js';

export interface IntegrityIssue {
  episodeId: string;
  severity: 'error' | 'warn';
  code: string;
  message: string;
  details?: Record<string, any>;
}

export interface IntegritySummary {
  scanned: number;
  ok: number;
  warnings: number;
  errors: number;
  issues: IntegrityIssue[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface IntegrityValidatorOptions {
  /** limit number of recent episodes to scan (by createdAt desc) */
  limit?: number;
  /** only scan episodes created after this ISO timestamp */
  createdAfter?: string;
  /** if true, perform HEAD on S3 objects referenced */
  verifyS3?: boolean;
  /** additionalData keys that must exist (always) */
  requiredAdditionalKeys?: string[];
  /** when master_m3u8 exists videoLocation must also exist */
  enforceVideoWithMaster?: boolean;
}

/** Utility to safely pull potential S3 urls from fields */
function extractUrls(ep: EpisodeRecord): string[] {
  const urls: string[] = [];
  const push = (v?: any) => {
    if (!v) return;
    if (typeof v === 'string' && v.startsWith('http')) urls.push(v);
    if (Array.isArray(v)) v.forEach(x => push(x));
  };
  push(ep.episodeUri);
  push(ep.transcriptUri);
  push(ep.processedTranscriptUri);
  push(ep.summaryAudioUri);
  push(ep.summaryTranscriptUri);
  push(ep.episodeImages);
  const add = ep.additionalData || {};
  ['videoLocation','master_m3u8','thumbnail','hlsMaster','hls_master']
    .forEach(k => push(add[k]));
  return Array.from(new Set(urls));
}

export class IntegrityValidator {
  constructor(private rds: RDSService | null, private s3: S3Service | null) {}

  static fromEnv(): IntegrityValidator {
    return new IntegrityValidator(createRDSServiceFromEnv(true), createS3ServiceFromEnv());
  }

  async validate(options: IntegrityValidatorOptions = {}): Promise<IntegritySummary> {
    const start = Date.now();
    const issues: IntegrityIssue[] = [];
    if (!this.rds) {
      throw new Error('RDS not configured; cannot run integrity validation');
    }

    const limit = options.limit ?? 200;
    const episodes = await this.fetchRecentEpisodes(limit, options.createdAfter);

    for (const ep of episodes) {
      // 1. Core field presence
      if (!ep.episodeTitle || !ep.channelId) {
        issues.push({ episodeId: ep.episodeId, severity: 'error', code: 'MISSING_CORE', message: 'Missing episodeTitle or channelId' });
      }

      // 2. additionalData required keys
      const add = ep.additionalData || {};
      for (const key of options.requiredAdditionalKeys || []) {
        if (!(key in add)) {
          issues.push({ episodeId: ep.episodeId, severity: 'error', code: 'MISSING_AD_KEY', message: `Missing additionalData.${key}` });
        }
      }

      // 3. Consistency: if master_m3u8 present but videoLocation missing
      if (options.enforceVideoWithMaster !== false && add.master_m3u8 && !add.videoLocation) {
        issues.push({ episodeId: ep.episodeId, severity: 'error', code: 'MASTER_WITHOUT_VIDEO', message: 'master_m3u8 present but videoLocation missing' });
      }

      // 4. Duration sanity
      if ((ep.durationMillis ?? 0) <= 0) {
        issues.push({ episodeId: ep.episodeId, severity: 'warn', code: 'DURATION_ZERO', message: 'durationMillis is zero or undefined', details: { durationMillis: ep.durationMillis } });
      }

      // 5. Processing flags correlation
      if (ep.processingDone && (!add.master_m3u8 || !add.videoLocation)) {
        issues.push({ episodeId: ep.episodeId, severity: 'warn', code: 'PROCESSING_DONE_MISSING_URLS', message: 'processingDone=true but required URLs missing', details: { processingDone: ep.processingDone, addKeys: Object.keys(add) } });
      }

      // 6. S3 existence checks
      if (options.verifyS3 && this.s3) {
        const urls = extractUrls(ep);
        for (const url of urls) {
          const exists = await this.s3.objectExistsByUrl(url);
            if (!exists) {
              issues.push({ episodeId: ep.episodeId, severity: 'error', code: 'S3_MISSING', message: `Referenced S3 object missing: ${url}` });
            }
        }
      }
    }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warn').length;
    const ok = episodes.length - new Set(issues.map(i => `${i.episodeId}:${i.code}`)).size;

    const summary: IntegritySummary = {
      scanned: episodes.length,
      ok,
      warnings,
      errors,
      issues,
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };

    if (errors > 0) {
      logger.error(`Integrity validation completed with errors: scanned=${summary.scanned} errors=${errors} warnings=${warnings}`);
    } else if (warnings > 0) {
      logger.warn(`Integrity validation completed with warnings: scanned=${summary.scanned} warnings=${warnings}`);
    } else {
      logger.info(`Integrity validation passed: scanned=${summary.scanned}`);
    }

  // Fire-and-forget CloudWatch metrics
  emitIntegrityScanMetric({ scanned: summary.scanned, errors, warnings }).catch(() => {});
  return summary;
  }

  private async fetchRecentEpisodes(limit: number, createdAfter?: string): Promise<EpisodeRecord[]> {
    // Custom lightweight query to avoid full object hydration cost (we rely on getEpisode for single fetch; here we scan many)
    const client: any = (this.rds as any).pool ? await (this.rds as any).pool.connect() : await (this.rds as any).getClient();
    try {
      const params: any[] = [];
      let idx = 1;
      let where = 'WHERE "deletedAt" IS NULL';
      if (createdAfter) {
        where += ` AND "createdAt" >= $${idx++}`;
        params.push(createdAfter);
      }
      const sql = `SELECT "episodeId" FROM public."Episodes" ${where} ORDER BY "createdAt" DESC LIMIT ${limit}`;
      const res = await client.query(sql, params);
      const episodes: EpisodeRecord[] = [];
      for (const row of res.rows) {
        const ep = await this.rds!.getEpisode(row.episodeId);
        if (ep) episodes.push(ep);
      }
      return episodes;
    } finally {
      if (client.release) client.release();
    }
  }
}

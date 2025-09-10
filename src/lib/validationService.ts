import { S3Service, createS3ServiceFromEnv } from './s3Service.js';
import { RDSService, createRDSServiceFromEnv } from './rdsService.js';
import { logger } from './utils/logger.js';
import { emitValidationMetric } from './cloudwatchMetrics.js';

export type PostProcessValidationResult = {
  ok: boolean;
  errors: string[];
  details?: Record<string, any>;
};

export class ValidationService {
  constructor(private s3: S3Service | null, private rds: RDSService | null) {}

  /**
   * Validate that RDS has required flags/fields and S3 objects exist.
   * - episodeId: required for DB lookup
   * - expect: keys to check in RDS additionalData and their presence
   * - s3Urls: list of S3/HTTPS URLs that must exist
   */
  async validateAfterProcessing(params: {
    episodeId: string;
    expectAdditionalData?: string[]; // e.g., ['videoLocation', 'master_m3u8']
    s3Urls?: string[];
  }): Promise<PostProcessValidationResult> {
    const errors: string[] = [];
    const details: Record<string, any> = {};

    // RDS checks
    if (this.rds) {
      try {
        const ep = await this.rds.getEpisode(params.episodeId);
        if (!ep) {
          errors.push(`RDS: episode not found: ${params.episodeId}`);
        } else {
          details.episode = { id: ep.episodeId, title: ep.episodeTitle };
          const add = ep.additionalData || {};
          for (const key of params.expectAdditionalData || []) {
            if (!(key in add) || add[key] === undefined || add[key] === null || String(add[key]).trim() === '') {
              errors.push(`RDS: missing/empty additionalData.${key}`);
            }
          }
        }
      } catch (err: any) {
        errors.push(`RDS: error fetching episode ${params.episodeId}: ${err?.message || err}`);
      }
    } else {
      logger.warn('Validation: RDS unavailable; skipping DB checks');
    }

    // S3 checks
    if (this.s3 && params.s3Urls?.length) {
      for (const url of params.s3Urls) {
        try {
          const exists = await this.s3.objectExistsByUrl(url);
          if (!exists) errors.push(`S3: object missing ${url}`);
        } catch (err: any) {
          errors.push(`S3: error checking ${url}: ${err?.message || err}`);
        }
      }
    } else if (!this.s3 && params.s3Urls?.length) {
      logger.warn('Validation: S3 unavailable; skipping object checks');
    }

    const ok = errors.length === 0;
    if (ok) logger.info('✅ Post-process validation OK');
    else logger.error('❌ Post-process validation FAILED', new Error('validation_failed'), { errors });

    // Emit CloudWatch metric (non-blocking)
    emitValidationMetric({
      episodeId: params.episodeId,
      success: ok,
      errors: errors.length,
      warnings: 0,
      stage: 'post_process'
    }).catch(() => {});

    return { ok, errors, details };
  }
}

export function createValidationServiceFromEnv(): ValidationService {
  const s3 = createS3ServiceFromEnv();
  const rds = createRDSServiceFromEnv();
  return new ValidationService(s3, rds);
}

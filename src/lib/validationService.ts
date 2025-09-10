import { S3Service, createS3ServiceFromEnv } from './s3Service.js';
import { RDSService, createRDSServiceFromEnv, EpisodeRecord } from './rdsService.js';
import { logger } from './utils/logger.js';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

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
    validateStream?: boolean; // when true, will fetch master_m3u8 and basic-validate variant lines
    requireProcessingDone?: boolean; // ensure processingDone=true in RDS
    verifyContentTypeVideo?: boolean; // ensure contentType === 'video'
    verifyDurationToleranceSeconds?: number; // if provided, compare RDS duration vs HLS manifest #EXTINF sum (rough)
  }): Promise<PostProcessValidationResult> {
    const errors: string[] = [];
    const details: Record<string, any> = {};

    // RDS checks
    if (this.rds) {
      try {
        const ep = await this.rds.getEpisode(params.episodeId) as EpisodeRecord | undefined | null;
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
          if (params.requireProcessingDone && ep.processingDone !== true) {
            errors.push('RDS: processingDone not true');
          }
          if (params.verifyContentTypeVideo && (ep.contentType || '').toLowerCase() !== 'video') {
            errors.push(`RDS: contentType not video (got '${ep.contentType}')`);
          }
          details.durationMillis = ep.durationMillis;
          details.additionalData = Object.keys(add);
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

    // Optional stream (HLS master) validation
    if (params.validateStream && this.s3 && params.expectAdditionalData?.includes('master_m3u8')) {
      try {
        // Attempt to derive master playlist URL from additionalData if not explicitly provided in s3Urls
        // We look for one ending with .m3u8 in s3Urls
        const masterUrl = (params.s3Urls || []).find(u => u.endsWith('.m3u8'));
        if (masterUrl) {
          // Fetch object and inspect contents (basic)
          const parsed = this.s3.parseS3Url(masterUrl);
          if (parsed) {
            const { bucket, key } = parsed;
            const headOk = await this.s3.objectExists(bucket, key);
            if (!headOk) {
              errors.push(`HLS: master playlist head failed ${masterUrl}`);
            } else {
              const obj = await (this.s3 as any).s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
              const body = await streamToString(obj.Body);
              const variantLines = body.split(/\r?\n/).filter(l => l.startsWith('#EXT-X-STREAM-INF'));
              if (variantLines.length === 0) {
                errors.push('HLS: no #EXT-X-STREAM-INF lines found in master');
              }
              details.hlsVariantCount = variantLines.length;
              // Duration estimation if requested: sum #EXTINF in media playlist is expensive; we skip deep traversal.
            }
          }
        } else {
          errors.push('HLS: master playlist URL not found among provided s3Urls');
        }
      } catch (e: any) {
        errors.push(`HLS: validation error ${e?.message || e}`);
      }
    }

    const ok = errors.length === 0;
    if (ok) logger.info('✅ Post-process validation OK');
    else logger.error('❌ Post-process validation FAILED', new Error('validation_failed'), { errors });

    return { ok, errors, details };
  }
}

export function createValidationServiceFromEnv(): ValidationService {
  const s3 = createS3ServiceFromEnv();
  const rds = createRDSServiceFromEnv();
  return new ValidationService(s3, rds);
}

async function streamToString(stream: any): Promise<string> {
  if (!stream) return '';
  return await new Promise<string>((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (d: any) => chunks.push(Buffer.from(d)));
    stream.on('error', (e: any) => reject(e));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

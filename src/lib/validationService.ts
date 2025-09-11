import { S3Service, createS3ServiceFromEnv } from './s3Service.js';
import { RDSService, createRDSServiceFromEnv, EpisodeRecord } from './rdsService.js';
import { logger } from './utils/logger.js';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';

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
  let ep: EpisodeRecord | undefined | null = undefined;
  if (this.rds) {
      try {
    ep = await this.rds.getEpisode(params.episodeId) as EpisodeRecord | undefined | null;
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

    // Optional stream (HLS master) validation and duration check
    if ((params.validateStream || params.verifyDurationToleranceSeconds) && this.s3) {
      try {
        // Attempt to derive master playlist URL from provided s3Urls or RDS
        let masterUrl = (params.s3Urls || []).find(u => u.endsWith('.m3u8'));
        if (!masterUrl && ep?.additionalData?.master_m3u8) {
          masterUrl = String(ep.additionalData.master_m3u8);
        }
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
              // Duration validation if requested
              if (params.verifyDurationToleranceSeconds && ep?.durationMillis) {
                try {
                  const mediaUri = selectBestVariantUri(body);
                  if (!mediaUri) {
                    errors.push('HLS: unable to resolve media playlist URI from master');
                  } else {
                    const resolved = resolveVariantToS3Key({ bucket, key }, mediaUri);
                    if (!resolved) {
                      errors.push(`HLS: unable to resolve media playlist S3 key for uri '${mediaUri}'`);
                    } else {
                      const mediaObj = await (this.s3 as any).s3Client.send(new GetObjectCommand({ Bucket: resolved.bucket, Key: resolved.key }));
                      const mediaBody = await streamToString(mediaObj.Body);
                      const hlsSeconds = sumExtInfSeconds(mediaBody);
                      const originalSeconds = Math.round((ep.durationMillis || 0) / 1000);
                      const diff = Math.abs(hlsSeconds - originalSeconds);
                      details.hlsDurationSeconds = hlsSeconds;
                      details.originalDurationSeconds = originalSeconds;
                      details.durationDiffSeconds = diff;
                      details.mediaPlaylistKey = resolved.key;
                      const tolerance = Math.max(0, params.verifyDurationToleranceSeconds || 0);
                      if (diff > tolerance) {
                        errors.push(`HLS: duration mismatch: HLS=${hlsSeconds}s vs original=${originalSeconds}s (diff ${diff}s > ${tolerance}s)`);
                      }
                    }
                  }
                } catch (durErr: any) {
                  errors.push(`HLS: error validating duration: ${durErr?.message || durErr}`);
                }
              }
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

/**
 * Pick the media playlist URI to use for duration checks.
 * Select the URI following the highest BANDWIDTH #EXT-X-STREAM-INF block; fallback to first.
 */
function selectBestVariantUri(masterBody: string): string | null {
  const lines = masterBody.split(/\r?\n/);
  type Variant = { bandwidth: number; uri: string };
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      let uri: string | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l) continue;
        if (l.startsWith('#')) break;
        uri = l;
        break;
      }
      const bwMatch = /BANDWIDTH=(\d+)/.exec(line) || /AVERAGE-BANDWIDTH=(\d+)/.exec(line);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      if (uri) variants.push({ bandwidth: bw || 0, uri });
    }
  }
  if (variants.length === 0) return null;
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants[0].uri;
}

/** Resolve a media playlist path (possibly relative) to S3 bucket/key using master bucket/key context */
function resolveVariantToS3Key(master: { bucket: string; key: string }, mediaUri: string): { bucket: string; key: string } | null {
  try {
    if (mediaUri.startsWith('http://') || mediaUri.startsWith('https://')) {
      const u = new URL(mediaUri);
      const hostParts = u.hostname.split('.');
      let bucket = '';
      if (hostParts.length >= 3 && hostParts[1] === 's3') bucket = hostParts[0];
      if (!bucket) return null;
      const key = u.pathname.replace(/^\/+/, '');
      return { bucket, key };
    }
    // Relative path into same bucket; resolve against master key directory using POSIX paths
    const dir = path.posix.dirname(master.key);
    const joined = path.posix.normalize(path.posix.join(dir, mediaUri));
    return { bucket: master.bucket, key: joined };
  } catch {
    return null;
  }
}

/** Sum all #EXTINF durations in seconds from a media playlist */
function sumExtInfSeconds(mediaBody: string): number {
  let total = 0;
  const re = /#EXTINF:([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mediaBody)) !== null) {
    const s = parseFloat(m[1]);
    if (!Number.isNaN(s)) total += s;
  }
  return Math.round(total);
}

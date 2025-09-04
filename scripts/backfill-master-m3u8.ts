import path from 'path';
import { createRDSServiceFromEnv } from '../src/lib/rdsService.js';
import { createS3ServiceFromEnv } from '../src/lib/s3Service.js';
import { getPublicUrl, getS3ArtifactBucket } from '../src/lib/s3KeyUtils.js';
import { create_slug } from '../src/lib/utils/utils.js';
import { logger } from '../src/lib/utils/logger.js';

type Variant = '1080p' | '720p' | '480p' | '360p';

// Default variant metadata
const VARIANT_INFO: Record<Variant, { resolution: string; bandwidth: number }> = {
  '1080p': { resolution: '1920x1080', bandwidth: 2500000 },
  '720p': { resolution: '1280x720', bandwidth: 1200000 },
  '480p': { resolution: '854x480', bandwidth: 700000 },
  '360p': { resolution: '640x360', bandwidth: 400000 },
};

const CODECS = 'avc1.4d401f,mp4a.40.2';

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, val] = a.split('=');
      args[key.replace(/^--/, '')] = val ?? true;
    } else if (!args._) {
      (args as any)._ = a;
    }
  }
  return args as { episodes?: string; file?: string; dryRun?: boolean | string };
}

async function readEpisodeIdsFromFile(filePath: string): Promise<string[]> {
  const fs = await import('fs/promises');
  const content = await fs.readFile(path.resolve(filePath), 'utf-8');
  return content
    .split(/\r?\n/) 
    .map(l => l.trim())
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = args.dryRun === true || args.dryRun === 'true';
  const inputIds: string[] = [];

  if (args.episodes) {
    inputIds.push(...args.episodes.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (args.file) {
    inputIds.push(...await readEpisodeIdsFromFile(String(args.file)));
  }

  if (inputIds.length === 0) {
    console.log('Usage: tsx scripts/backfill-master-m3u8.ts --episodes=id1,id2[,id3] [--dryRun]');
    console.log('   or: tsx scripts/backfill-master-m3u8.ts --file=episodeIds.txt [--dryRun]');
    process.exit(1);
  }

  const rds = createRDSServiceFromEnv();
  if (!rds) {
    console.error('RDS env not configured. Set RDS_HOST, RDS_USER, RDS_PASSWORD, etc.');
    process.exit(1);
  }
  await rds.initClient();

  const s3 = createS3ServiceFromEnv();
  if (!s3) {
    console.error('S3 env not configured. Set S3_ARTIFACT_BUCKET and AWS creds.');
    process.exit(1);
  }
  const defaultBucket = getS3ArtifactBucket();

  let successCount = 0;
  for (const episodeId of inputIds) {
    try {
      logger.info(`\n=== Processing episode ${episodeId} ===`);
      const ep = await rds.getEpisode(episodeId);
      if (!ep) {
        logger.warn(`Episode not found: ${episodeId}`);
        continue;
      }

      // Determine bucket and prefix based on additionalData.master_m3u8 or videoLocation
      let bucket = defaultBucket;
      let prefix: string | null = null;
      let prefixSource: 'master_m3u8' | 'videoLocation' | 'fallback' | 'none' = 'none';

      const ad: any = (ep as any).additionalData || {};

      // Skip episodes that don't have videoLocation key
      if (!ad.videoLocation) {
        logger.warn(`Episode ${episodeId} has no videoLocation in additionalData — skipping.`);
        continue;
      }

      // Helper to parse S3-style HTTPS URL
      const parseS3Https = (urlStr: string): { bucket: string; key: string } | null => {
        try {
          const u = new URL(urlStr);
          // host like: <bucket>.s3.<region>.amazonaws.com
          const hostParts = u.hostname.split('.');
          const bkt = hostParts[0];
          const key = u.pathname.replace(/^\//, '');
          if (!bkt || !key) return null;
          return { bucket: bkt, key };
        } catch {
          return null;
        }
      };

      if (ad.master_m3u8) {
        const parsed = parseS3Https(ad.master_m3u8);
        if (parsed) {
          bucket = parsed.bucket || bucket;
          const keyDir = parsed.key.endsWith('/') ? parsed.key : parsed.key.substring(0, parsed.key.lastIndexOf('/') + 1);
          prefix = keyDir; // expected to be .../original/video_stream/
          prefixSource = 'master_m3u8';
        }
      }

      if (!prefix && ad.videoLocation) {
        const parsed = parseS3Https(ad.videoLocation);
        if (parsed) {
          bucket = parsed.bucket || bucket;
          // Replace .../original/videos/<file> -> .../original/video_stream/
          const parts = parsed.key.split('/');
          const idx = parts.indexOf('original');
          if (idx >= 0 && parts[idx + 1] === 'videos') {
            const baseParts = parts.slice(0, idx + 1); // up to 'original'
            prefix = baseParts.join('/') + '/video_stream/';
            prefixSource = 'videoLocation';
          }
        }
      }

      if (!prefix) {
        // Fallback to slug derivation using channelName (podcast) and episodeTitle
        const podcastSlug = create_slug(ep.channelName || 'unknown');
        const episodeSlug = create_slug(ep.episodeTitle || 'untitled');
        prefix = `${podcastSlug}/${episodeSlug}/original/video_stream/`;
        prefixSource = 'fallback';
      }

      logger.info(`Using S3 prefix '${prefix}' (derived from: ${prefixSource})`);

      const order: Variant[] = ['720p', '480p', '360p'];
      const present: Variant[] = [];
      for (const v of order) {
        const key = `${prefix}${v}/${v}.m3u8`;
        const exists = await s3.fileExists(bucket, key).catch(() => false);
        if (exists) {
          present.push(v);
          logger.info(`Found variant: ${v}`);
        }
      }

      if (present.length === 0) {
        logger.warn(`No rendition playlists found under s3://${bucket}/${prefix} — skipping.`);
        continue;
      }

      // Build master.m3u8 content
      const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:7'];
      for (const v of present) {
        const info = VARIANT_INFO[v];
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${info.bandwidth},RESOLUTION=${info.resolution},CODECS="${CODECS}"`);
        lines.push(`${v}/${v}.m3u8`);
      }
      const masterKey = `${prefix}master.m3u8`;
      const masterBody = Buffer.from(lines.join('\n') + '\n', 'utf-8');

      if (dryRun) {
        logger.info(`[dryRun] Would upload master to s3://${bucket}/${masterKey}`);
        logger.info(`[dryRun] Variants included: ${present.join(', ')}`);
        logger.info(`[dryRun] Content:\n${masterBody.toString('utf-8')}`);
        successCount++;
      } else {
        const put = await s3.uploadm3u8ToS3(masterBody, bucket, masterKey);
        if (!put.success) {
          throw new Error(put.error || 'Failed to upload master.m3u8');
        }
        const publicUrl = getPublicUrl(bucket, masterKey);
        // Update RDS additionalData.master_m3u8 to match main process behavior
        await rds.updateEpisode(episodeId, {
          additionalData: { ...ad, master_m3u8: publicUrl },
          processingDone: true,
        });
        successCount++;
        logger.info(`✅ Uploaded and recorded master.m3u8 for ${episodeId}: ${publicUrl}`);
      }
    } catch (err: any) {
      logger.error(`❌ Failed for episode ${episodeId}: ${err.message || String(err)}`);
      if (err.stack) {
        logger.error(err.stack);
      }
    }
  }

  logger.info(`\nDone. Master playlist updated for ${successCount}/${inputIds.length} episodes.`);
  await rds.closeClient();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

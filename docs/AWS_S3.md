# AWS S3 usage and validation

This document describes how S3 is configured and used in the pipeline, how object keys are generated, and how outputs are validated.

Sources: `src/lib/s3Service.ts`, `src/lib/s3KeyUtils.ts`, `src/lib/integrityValidator.ts`.

## Configuration

- Region: `us-east-1` (set in `createS3ServiceFromEnv()`).
- Buckets: both audio and video currently use `S3_ARTIFACT_BUCKET`.
  - Note: Logs mention `S3_AUDIO_BUCKET`/`S3_VIDEO_BUCKET`, but the constructor uses `S3_ARTIFACT_BUCKET` for both.
- Credentials: default AWS SDK chain unless `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are provided.
- Optional key prefixes: `S3_VIDEO_KEY_PREFIX`, `S3_AUDIO_KEY_PREFIX` (prepended as-is to generated keys).

## Unified S3 key conventions

Slugs are derived from `metadata.uploader` (podcast title) and `metadata.title` (episode title).

- Audio file
  - Pattern: `[prefix]podcast-slug/episode-slug/original/audio/episode-slug.mp3`
  - Builder: `generateAudioS3Key(metadata, customFilename?)`
- Video renditions (original MP4s)
  - Pattern: `[prefix]podcast-slug/episode-slug/original/videos/<definition>.mp4` (e.g., 1080p, 720p, 480p, 360p)
  - Builder: `generateLowerDefVideoS3Key(metadata, definition, customFilename?)`
- HLS master playlist
  - Pattern: `[prefix]podcast-slug/episode-slug/original/video/master.m3u8` (singular `video` segment)
  - Builder: `generateM3U8S3Key(metadata)`
- Thumbnail
  - Pattern: `[prefix]podcast-slug/episode-slug/original/image/episode-slug.jpg`
  - Builder: `generateThumbnailS3Key(metadata, customFilename?)`

Helpers:

- `parseS3Key(key)` → `{ podcastSlug, episodeSlug, type, filename }` (for audio/video/metadata shapes)
- `isValidUnifiedS3Key(key)` → boolean (validates expected shapes)
- `getPublicUrl(bucket, key)` → `https://<bucket>.s3.us-east-1.amazonaws.com/<key>`

## Core operations

- Upload file (multipart tuned)
  - `uploadFile(filePath, bucket, key, contentType?)`
  - Defaults: `S3_UPLOAD_PART_SIZE_MB=32` (MB), `S3_UPLOAD_QUEUE_SIZE` scales with IO (capped at 16)
  - Emits CloudWatch metrics: `StepSuccess`/`StepFailure`/`StepDurationMillis` with `Step=s3_upload_video` and `Bucket` dimension
  - Wrappers: `uploadAudioFile(filePath, keyPrefix?)`, `uploadVideoFile(filePath, keyPrefix?)`
- Upload in-memory content
  - `uploadm3u8ToS3(buf, bucket, key)`; `uploadThumbnailToS3(buf, bucket, key)`
- Download file (ranged, concurrent)
  - `downloadFile(bucket, key, dst, { partSizeMB?, concurrency? })`
  - Defaults: `S3_DOWNLOAD_PART_SIZE_MB=32`, `S3_DOWNLOAD_CONCURRENCY` scales with IO
  - Emits `StepSuccess`/`StepFailure`/`StepDurationMillis` with `Step=s3_download`
- Existence checks
  - `objectExists(bucket, key)` via HEAD
  - `objectExistsByUrl(url)` parses S3/HTTPS then HEADs
- Utility
  - `getPresignedDownloadUrl(bucket, key, expiresIn?)`
  - `deleteFile(bucket, key)`; `fileExists(bucket, key)`
  - Local cleanup: `deleteLocalFile(path)` + empty dir pruning

Reliability and backoff:

- Retries: wrapper uses exponential backoff (max 3). Non-retryable AWS codes (e.g., `AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `NoSuchBucket`) fail fast.
- Concurrency control: process-local semaphore (`withSemaphore`) limits parallel S3 ops to reduce contention.

## Validation flows

1. Immediate operation feedback

- `uploadFile`/`downloadFile` return success booleans and error strings.
- CloudWatch ops metrics fire on success/failure with step-specific dimensions:
  - `Step=s3_upload_video` for uploads; `Step=s3_download` for downloads.

1. Batch integrity validation (post-process)

- Entrypoint: `IntegrityValidator.fromEnv().validate({ limit?, createdAfter?, verifyS3?, requiredAdditionalKeys?, enforceVideoWithMaster? })`
- Per-episode checks:
  - Core fields present (`episodeTitle`, `channelId`)
  - `additionalData` keys present (from `requiredAdditionalKeys`)
  - Consistency: if `master_m3u8` exists but `videoLocation` is missing → `MASTER_WITHOUT_VIDEO` (unless disabled)
  - Duration sanity: `durationMillis > 0`
  - S3 existence checks when `verifyS3=true`:
    - Extract URLs from episode fields and `additionalData` keys: `videoLocation`, `master_m3u8`, `thumbnail`, `hlsMaster`, `hls_master`
    - Perform HEAD via `objectExistsByUrl`; any missing → `S3_MISSING`
- Emits validation metrics: `IntegrityScanErrors`, `IntegrityScanWarnings`, `IntegrityScanTotal`, `IntegrityScanFailed` (1 if any errors)

1. Alarm coverage

- Real-time S3 failures are caught by the Ops alarm on `StepFailure` (see `docs/AWS_CLOUDWATCH.md`).
- Periodic integrity scans can be alarmed by creating alarms on the IntegrityScan* metrics.

## Environment variables

- Buckets: `S3_ARTIFACT_BUCKET`
- Optional prefixes: `S3_VIDEO_KEY_PREFIX`, `S3_AUDIO_KEY_PREFIX`
- Upload tuning: `S3_UPLOAD_PART_SIZE_MB`, `S3_UPLOAD_QUEUE_SIZE`
- Download tuning: `S3_DOWNLOAD_PART_SIZE_MB`, `S3_DOWNLOAD_CONCURRENCY`
- AWS creds: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (optional; default chain supported)

## Examples

Generate keys and upload audio:

```ts
import { S3Service } from '../src/lib/s3Service';
import { generateAudioS3Key } from '../src/lib/s3KeyUtils';

const s3 = new S3Service({ region: 'us-east-1', audioBucket: process.env.S3_ARTIFACT_BUCKET!, videoBucket: process.env.S3_ARTIFACT_BUCKET! });
const key = generateAudioS3Key(metadata);
await s3.uploadAudioFile('/tmp/out.mp3');
```

Integrity scan with S3 verification:

```ts
import { IntegrityValidator } from '../src/lib/integrityValidator';

const summary = await IntegrityValidator.fromEnv().validate({ limit: 200, verifyS3: true, enforceVideoWithMaster: true });
console.log(summary.errors, summary.warnings);
```

## See also

- CloudWatch metrics/alarms: `docs/AWS_CLOUDWATCH.md`
- HLS outputs and validation: `docs/MP4_TO_HLS.md`
- End-to-end flow: `docs/Guide_to_understanding_to_process.md`

# End-to-End Pipeline Guide

This guide explains the full lifecycle of a job in our video pipeline: from how work enters the system to how we download, merge, transcode to HLS, upload to S3, update the database, validate outputs, and manage ECS task protection. It’s written to be practical and low-level.

## High-level flow

1. Ingress
	- HTTP: client posts to `POST /api/download` with `{ url }`.
	- SQS: a polling worker ingests messages and calls the same processing path.
2. Job creation
	- Server validates/sanitizes URL, generates `jobId`, stores an in-memory job entry, and background-invokes `processDownload(jobId, url, sqsMessage?)`.
3. Protection
	- If running on ECS (on-demand capacity), we enable Task Protection immediately and keep it renewed while any jobs are active.
4. Processing
	- Fetch YouTube metadata.
	- Download audio-only and video-only in parallel to a temp folder.
	- Upload audio quickly to S3 and create/update the episode in RDS.
	- Merge audio+video to a final MP4.
	- Upload the MP4 to S3.
	- Render HLS renditions and master playlist and upload all to S3.
	- Update RDS `additionalData` and mark `processingDone = true`.
5. Validation and cleanup
	- Validate RDS + S3 + HLS basics, emit metrics.
	- Clean temporary files and empty directories.
6. Completion
	- Job remains queryable via `GET /api/job/:jobId`.

## Ingress and APIs

- `POST /api/download` starts a new job from a YouTube URL.
	- Validates the URL format (YouTube-only) and sanitizes it.
	- Creates a job entry: `{ id, url, status, progress, createdAt }`.
	- Immediately returns `{ success, jobId }` while processing continues async.
- `GET /api/job/:jobId` returns the job status and progress info.
- `GET /api/jobs` lists jobs (most recent first).
- `DELETE /api/job/:jobId` removes the in-memory job record.
- Operational endpoints: `/health`, `/api/update-ytdlp`, `/api/update-status`, `/api/enable-shutdown`, `/api/shutdown`.

SQS workers enqueue or read messages following the formats documented in the root index endpoint. Workers ultimately call the same `processDownload` path.

## Where files live locally

- Binaries: `bin/yt-dlp`, `bin/ffmpeg`, `bin/ffprobe`.
- Downloads root: `downloads/` (served under `/downloads`).
- Temporary files: `downloads/temp/`.
- Cookies (if present): `.config/yt-dlp/yt-dlp-cookies.txt`.

## Concurrency and throttling

- yt-dlp parallel connections are tuned to CPU core count unless overridden (`YTDLP_CONNECTIONS`).
- FFmpeg runs are serialized with disk semaphores to avoid I/O contention.(In concurrent programming for an operating system, a semaphore is a synchronization primitive used to control access to a shared resource like a disk drive. Semaphores prevent problems such as race conditions by ensuring that only a certain number of processes or threads can access the resource at a time. )
- A greedy mode may limit disk concurrency to keep resource usage predictable on small Fargate tasks.

## Detailed processing path

Below describes the main pipeline inside `processDownload()` and helpers in `src/lib/ytdlpWrapper.ts`.

### 1) Enable Task Protection (ECS)

- We attempt to discover ECS identity (`ensureEcsIdentity`). If detected and capacity is on-demand, we enable Task Protection for 120 minutes and start a periodic renewal via `manageTaskProtection` as long as jobs are active.
- On Spot capacity, we no-op for protection and rely on fast requeue on interruption (handled elsewhere).

### 2) Fetch metadata

- `getVideoMetadata(url)` invokes `yt-dlp --dump-json` with:
	- Cookies file if available.
	- Plugin directory and extractor args (BGUTIL provider URL).
	- Optional `--ffmpeg-location bin/ffmpeg`.
- We parse JSON output into our `VideoMetadata` shape. Errors emit CloudWatch metrics (step failure + duration) and may surface as fatal for the job.

### 3) Parallel downloads (audio-only and video-only)

- Video-only: `downloadVideoNoAudioWithProgress(url, options, videoDefinition, metadata)`
	- Chooses a `bestvideo[...]` format up to 1080p or 720p depending on metadata size heuristics.
	- Writes to `downloads/temp/video_<ts>_<podcastSlug>_<episodeSlug>.*`.
- Audio-only: `downloadPodcastAudioWithProgress(url, options, metadata)`
	- Picks `bestaudio` with a preferred container (e.g., mp3/m4a/aac/opus selection).
	- Writes to `downloads/temp/audio_<ts>_<podcastSlug>_<episodeSlug>.*`.
	- On completion, we immediately upload audio to S3 (key derived from metadata) and keep local copy for merging.
- Both functions emit progress lines that the server can surface for clients.

### 4) Create/update episode in RDS (after audio upload)

- We initialize the `RDSService` when available.
- If an episode exists by `youtubeVideoId`:
	- If it is fully processed (`videoLocation` + `master_m3u8` + `processingDone=true`): skip processing, optionally update guest extraction, and return.
	- If `videoLocation` exists but `master_m3u8` is missing or `processingDone=false`: mark for reprocessing (later steps handle HLS only).
	- Otherwise, continue normal processing.
- If none exists, we create a new episode, store audio location and thumbnail, and optionally update guest extraction.
- For new episodes, we also prepare a transcription queue message with `{ episodeId, audioUri }`.

### 5) Merge audio + video into MP4

- `mergeVideoAudioWithValidation(videoPath, audioPath, outputPath)` runs FFmpeg:
	- `-c copy` with timestamp fixes (`-avoid_negative_ts make_zero`, `-fflags +genpts`).
	- Validates that the output file exists and is non-empty.
- Output path: `downloads/<podcastSlug>/<episodeSlug>/<episodeSlug>.mp4`.
- Temp files are deleted, and empty temp directories are cleaned up.

### 6) Upload MP4 to S3 and update RDS

- We compute the video S3 key from metadata (including extension/definition), upload to the artifact bucket, and then update the episode `additionalData.videoLocation`. Local MP4 may be deleted afterward.

### 7) Render HLS renditions and upload to S3

- `renderingLowerDefinitionVersions(finalMergedPath, metadata, topEdition, s3, bucket)`:
	- Builds multiple renditions (1080p/720p/480p/360p based on `topEdition`) in a single FFmpeg run.
	- Uses fMP4 single-file HLS (`-hls_flags single_file`, `-hls_segment_type fmp4`, `-hls_time 6`).
	- Writes variant playlists in subfolders and a `master.m3u8` at `hls_output/`.
	- If FFmpeg didn’t emit a master playlist, we generate one manually.
	- Uploads the entire `hls_output/` folder to S3 under `/{uploaderSlug}/{episodeSlug}/original/video_stream/`.
	- Returns a public `master.m3u8` URL.
- RDS is updated with `additionalData.master_m3u8`, `processingDone=true`, and `isSynced=false`.

### 8) Validation

- `ValidationService.validateAfterProcessing({ episodeId, expectAdditionalData, s3Urls, validateStream, requireProcessingDone, verifyContentTypeVideo, verifyDurationToleranceSeconds })`:
	- Confirms episode exists and required fields are present in RDS.
	- Ensures referenced S3 objects exist (HEAD/fetch).
	- Optionally fetches `master.m3u8` and checks that it contains `#EXT-X-STREAM-INF` lines.
	- Optionally picks the highest bandwidth variant, fetches its media playlist, sums `#EXTINF` durations, and compares to the episode’s original duration within a tolerance (e.g., 2s).
	- Emits success/failure metrics.

### 9) Cleanup

- HLS output directory is removed from local disk after upload.
- Podcast directories are cleaned if empty.

## Reprocessing path (existing video, missing HLS)

If an episode exists with `videoLocation` but without `master_m3u8` or `processingDone=false`:

1. Download the original MP4 from S3 into the episode folder.
2. Run the HLS rendering step as above and upload results.
3. Update RDS with `master_m3u8` and `processingDone=true`.
4. Remove local MP4 and clean directories.

## Error handling and resilience

- Each step emits CloudWatch metrics: success/failure and duration (namespace: `VideoPipeline`).
- yt-dlp failures can trigger a guarded fatal path (`triggerYtdlpFatal`): emit error metric, request SQS poller drain, and gracefully shutdown the container.
- FFmpeg AAC encoder assertion is auto-detected; we retry with `-c:a copy` fallback.
- All critical file operations validate existence and size; cleanups are wrapped and tolerant of races.
- With-retry wrappers are used on transient operations (FFmpeg exec, S3 uploads).

## ECS integration and task protection

- Identity discovery: via `ECS_CONTAINER_METADATA_URI*_` when `ECS_CLUSTER_NAME`/`ECS_TASK_ARN` aren’t provided.
- Capacity modes:
	- On-demand: enable `UpdateTaskProtection` for 60–120 minutes and auto-renew while jobs are active.
	- Spot: protection no-op; interruption handling is outside this flow (fast requeue).
- Health endpoint reflects protection and capacity state.

## Environment configuration (selected)

- S3_UPLOAD_ENABLED: enable uploads.
- AWS_REGION: AWS region for S3/ECS/CloudWatch.
- RDS_HOST, RDS_USER, RDS_PASSWORD, RDS_DATABASE, RDS_PORT: DB connection (SSL required).
- ENABLE_SQS_POLLING: control SQS poller.
- PODCAST_CONVERSION_ENABLED: generic toggle.
- YTDLP_CONNECTIONS: override CPU-based yt-dlp connections.
- FFMPEG_THREADS: if set, can constrain FFmpeg threads.
- FARGATE_CAPACITY / FARGATE_CAPACITY_TYPE: `on_demand` or `spot`.
- BGUTIL_PROVIDER_URL: extractor base URL for yt-dlp plugins.

## Outputs summary

- Audio S3 URL (immediately after audio download): used for transcription.
- Video S3 URL (after merging): stored in `additionalData.videoLocation`.
- Master HLS URL: stored in `additionalData.master_m3u8`.
- RDS episode record: includes duration, metadata, and flags (`processingDone`, `isSynced`).

## Minimal example: kick off a job

```bash
curl -sS -X POST http://localhost:3000/api/download \
	-H 'content-type: application/json' \
	-d '{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }'
```

Then monitor:

```bash
curl -sS http://localhost:3000/api/job/<jobId>
```

The final episode artifacts will be available via S3 (and, if needed, locally under `/downloads`).


## See also

- MP4 ➜ HLS details: `docs/MP4_TO_HLS.md`
- yt-dlp setup/update/usage: `docs/YTDLP_props.md`
- ECS on-demand vs. Spot: `docs/ECS_OPTIMIZATIONS.md`


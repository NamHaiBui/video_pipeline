# Video pipeline (YouTube → audio/video → HLS → S3)

This app downloads a YouTube video, extracts MP3 audio, merges audio+video, renders HLS variants, and (optionally) uploads results to S3. It exposes a simple HTTP API and can also run as an ECS worker that reads jobs from SQS.

Keep it simple: install, run, hit the API, and you’ll get files in a local downloads/ folder or in S3 if you enable it.

## What you get

- yt-dlp + ffmpeg are auto-installed into local bin/ on install
- Download video and/or audio
- Merge into one MP4
- Make HLS playlists and renditions
- Upload to S3 (optional)
- Small API to start a download and check status

## Requirements

- Node.js 18+ (ES modules + tsx)
- Python 3 (used to run the portable yt-dlp script on Alpine-like systems)
- wget, xz, tar (only needed once to fetch ffmpeg/ffprobe during setup)
- Optional: AWS account/creds if you want to upload to S3 or use SQS/RDS

## Install

```bash
npm install
```

On install, the app downloads yt-dlp and ffmpeg/ffprobe to bin/ and makes them executable. If that fails on your machine, run:

```bash
npm run setup
```

Tip: If you plan to download members-only or age-gated videos, put your browser cookies at `.config/yt-dlp/yt-dlp-cookies.txt` (project root). The app will pick it up automatically.

## Run (local)

Development (TypeScript with live tsx):

```bash
npm run dev
```

Build + run (compiled to dist/):

```bash
npm run start
```

Server listens on `PORT` (default 3000).

## Minimal usage (HTTP API)

Start a download:

```bash
curl -X POST http://localhost:3000/api/download \
	-H 'Content-Type: application/json' \
	-d '{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}'
```

Response (example):

```json
{ "success": true, "jobId": "<uuid>", "message": "Job created" }
```

Check job status:

```bash
curl http://localhost:3000/api/job/<jobId>
```

List all jobs:

```bash
curl http://localhost:3000/api/jobs
```

Health check:

```bash
curl http://localhost:3000/health
```

Where files go (local):

- downloads/podcasts/`podcast-slug`/`episode-slug`/*.mp3
- downloads/`podcast-slug`/`episode-slug`/`episode-slug`.mp4
- HLS renditions are created under a temporary folder during processing and uploaded to S3 when enabled

## Enable S3 uploads (optional)

Set these environment variables, then restart the app:

- S3_UPLOAD_ENABLED=true
- AWS_REGION=us-east-1 (or your region)
- AWS_ACCESS_KEY_ID=...
- AWS_SECRET_ACCESS_KEY=...
- S3_ARTIFACT_BUCKET=your-artifact-bucket
- Optional key prefixes:
	- S3_VIDEO_KEY_PREFIX=some/prefix/
	- S3_AUDIO_KEY_PREFIX=some/prefix/

The app will upload:

- Audio MP3 to: s3://S3_ARTIFACT_BUCKET/`podcast`/`episode`/original/audio/`episode`.mp3
- Video MP4 to: s3://S3_ARTIFACT_BUCKET/`podcast`/`episode`/original/videos/`quality`.mp4
- HLS master to: s3://S3_ARTIFACT_BUCKET/`podcast`/`episode`/original/video_stream/master.m3u8

## SQS worker (optional)

If you want a worker that pulls jobs from SQS (typical on ECS):

Required env:

- `SQS_QUEUE_URL=https://sqs.region.amazonaws.com/account-id/queue-name`
- AWS_REGION=<your-region>
- AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (if not using a task role)

Useful env:

- MAX_CONCURRENT_JOBS=number (defaults to CPU-aware)
- POLLING_INTERVAL_MS=5000
- SQS_VISIBILITY_SECONDS=300 (message invisibility while processing)
- SQS_REQUEUE_ON_TIMEOUT_SECONDS=30
- SPOT_REQUEUE_VISIBILITY_SECONDS=5
- AUTO_EXIT_ON_IDLE=false

In production we run a separate worker that imports `startSQSPolling()` from `src/sqsPoller.ts`. If you’re containerizing, run a worker image with those env vars set.

## RDS (optional)

If you store episode metadata in Postgres (RDS):

- RDS_HOST, RDS_USER, RDS_PASSWORD, RDS_DATABASE, RDS_PORT
- SSL is always required (the client uses `ssl: { rejectUnauthorized: false }`).

The server can enrich and update episodes when uploads complete.

## Update yt-dlp

Run the script shortcut (defined in package.json):

```bash
npm run update-ytdlp
```

Nightly build / force / skip version check:

```bash
npm run update-ytdlp:nightly
npm run update-ytdlp:force
npm run update-ytdlp:skip-check
```

If the shortcut is not available in your branch, you can run the updater directly:

```bash
npx tsx src/lib/yt_dlp_update_script.ts
```

## Advanced tune-ups (optional)

- Cookies file: `.config/yt-dlp/yt-dlp-cookies.txt` (absolute or project-relative path)
- Connections for yt-dlp: `YTDLP_CONNECTIONS` (defaults to CPU-aware)
- Preferred audio format: `PREFERRED_AUDIO_FORMAT=mp3|opus|aac|m4a` (default mp3)
- ffmpeg/yt-dlp locations are auto-detected from `bin/` after setup
- Retry knobs: `RETRY_ATTEMPTS`, `RETRY_BASE_DELAY_MS`
- S3 upload tuning: `S3_UPLOAD_PART_SIZE_MB`, `S3_UPLOAD_QUEUE_SIZE`
- S3 download tuning: `S3_DOWNLOAD_PART_SIZE_MB`, `S3_DOWNLOAD_CONCURRENCY`
- Custom extractor base URL: `BGUTIL_PROVIDER_URL` (used in `--extractor-args`)

## Docker (local)

Build and run with Docker Compose:

```bash
docker compose up --build
```

Place your environment in a `.env` file in the project root if needed. The server port is published according to the compose file.

## ECS (Fargate / Fargate Spot)

Runtime behavior is controlled by env:

- FARGATE_CAPACITY=on_demand or spot

On-demand enables ECS Task Protection during active work to avoid scale-in. Spot skips protection and requeues in-flight jobs on interruption. See `docs/ECS_OPTIMIZATIONS.md` for short, practical details.

## Further docs

- End-to-end pipeline guide: `docs/Guide_to_understanding_to_process.md`
- MP4 ➜ HLS details: `docs/MP4_TO_HLS.md`
- yt-dlp setup, update, and usage: `docs/YTDLP_props.md`
- ECS on-demand vs. Spot behavior: `docs/ECS_OPTIMIZATIONS.md`

## Project structure (short)

- src/server.ts: HTTP API
- src/lib/ytdlpWrapper.ts: All yt-dlp + ffmpeg operations
- src/lib/update_ytdlp.ts and src/lib/yt_dlp_update_script.ts: yt-dlp updater
- src/lib/s3Service.ts, src/lib/s3KeyUtils.ts: S3 client and key helpers
- src/sqsPoller.ts: SQS worker logic
- bin/: downloaded yt-dlp, ffmpeg, ffprobe

## Troubleshooting

- “yt-dlp not found”: run `npm run setup` (or reinstall). Ensure Python 3 is installed; the portable script may use it.
- “ffmpeg not found”: `npm run setup` fetches it into bin/.
- “Cannot access S3/SQS”: check AWS creds, region, IAM role. Verify `S3_ARTIFACT_BUCKET`/`SQS_QUEUE_URL`.
- “Stuck or slow downloads”: set `YTDLP_CONNECTIONS`, check network, and make sure cookies are valid for the content you’re downloading.
- Alpine images: the portable yt-dlp script runs via `python3` automatically if direct exec fails.


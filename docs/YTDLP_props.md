# YT-DLP in the pipeline: setup and updates

This document explains, in detail, how the project downloads, installs, and updates the external yt-dlp and ffmpeg binaries.

Contents

- Overview
- Setup: `src/lib/setup_binaries.ts`
- Update: `src/lib/yt_dlp_update_script.ts` (wrapper) + `src/lib/update_ytdlp.ts` (engine)
- File paths and side effects
- Exit codes and logging
- Error handling and retries
- Dependencies and environment
- Usage examples
- Troubleshooting

## Overview

- YT-DLP is a Python-based tool used for downloading and extracting media. We ship it as a standalone binary (portable script) that works on musl (Alpine) and glibc systems.

- ffmpeg/ffprobe are required for media processing; they are downloaded from prebuilt releases.

- Binaries are placed in the project-local `bin/` directory and made executable.

## Setup: `src/lib/setup_binaries.ts`

Purpose

- Ensure `bin/` exists.
- Download yt-dlp to `bin/yt-dlp` if missing.
- Download and extract ffmpeg and ffprobe to `bin/ffmpeg` and `bin/ffprobe` if missing.

Key paths and constants

- BIN_DIR: `.../bin` (resolved relative to the file via ESM-safe `fileURLToPath`)
- YTDLP_URL: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`
- FFMPEG_DOWNLOAD_COMMAND: a shell pipeline using `wget | xz | tar -x` to fetch the latest linux64 GPL build
- FFMPEG_EXPECTED_EXTRACTED_DIR_PATTERN: `^ffmpeg-master-latest-linux\d+-\w+` used to detect the extracted directory
- Final executables: `bin/yt-dlp`, `bin/ffmpeg`, `bin/ffprobe`

Inputs

- None (script is self-contained). Invoked by npm `postinstall` and the `setup` script.

Outputs/side effects

- Creates `bin/` if missing.
- Writes files to `bin/` and sets `0755` permissions.
- Removes the temporary extracted ffmpeg directory after moving binaries.

Execution flow (happy path)

1) Ensure `bin/` exists.

2) If `bin/yt-dlp` does not exist:
	- Stream-download from `YTDLP_URL` with Axios (progress bar shown when `content-length` provided).
	- Write to `bin/yt-dlp` and `chmod 755`.

3) If `bin/ffmpeg` does not exist:
	- Run the shell pipeline: `wget -O - ... | xz -qdc | tar -x` with `cwd=bin/`.
	- Find the extracted directory via regex pattern match.
	- Move `ffmpeg` and `ffprobe` out to `bin/ffmpeg` and `bin/ffprobe` and `chmod 755` each.
	- Delete the extracted directory.

4) Print completion and `process.exit(0)`.

Error handling

- Download errors are caught and rethrown with a clear message (Axios stream errors).
- If the ffmpeg shell pipeline fails, the script prints guidance to install `wget`, `xz`, and `tar` or place binaries manually.
- On any unhandled failure in `setupBinaries()`, the catch handler prints and exits with `process.exit(1)`.

Progress display

- Uses the `progress` package. If `content-length` is not present, the bar is omitted and a generic “size unknown” message is shown.

Logging

- Uses `logger.info` for high-level milestones and `console.log`/`console.error` for shell and extraction steps.

Integration points

- `package.json` runs this script on `postinstall` and via `npm run setup`.

## Update: `src/lib/yt_dlp_update_script.ts` + `src/lib/update_ytdlp.ts`

There are two pieces:

- Wrapper/CLI: `yt_dlp_update_script.ts` — parses flags, invokes the engine, and maps results to exit codes/messages.
- Engine: `update_ytdlp.ts` — does the actual version check, download (with retries/fallbacks), replacement, and verification.

### Wrapper/CLI: `src/lib/yt_dlp_update_script.ts`

Purpose

- Provide a simple command-line entry point to update yt-dlp.

Flags (parsed from `process.argv`)

- `--nightly`, `-n`: use the nightly builds instead of stable.
- `--force`, `-f`: force download even if the current version matches the latest (only applies when version check runs).
- `--skip-version-check`, `-s`: skip GitHub API calls; just download the latest asset (useful when rate limited or API down).

Behavior

- Prints starting banner and the parsed options.
- Handles `SIGINT`/`SIGTERM` to exit gracefully with code 0.
- Calls `checkAndUpdateYtdlp(options)` from the engine and interprets the boolean result:
	- `true`  => update performed successfully, exit 0.
	- `false` => “No update was needed or update failed”, exit 0 (non-fatal for CI/automation), plus tailored hints based on `--skip-version-check`.
- On thrown errors (rare): prints a root-cause hint (503/403/timeout) and exits 1.

Exit codes

- 0: completed (updated or no update needed, or non-fatal failure).
- 1: fatal wrapper error (uncaught exception).

### Engine: `src/lib/update_ytdlp.ts`

Purpose

- Check current yt-dlp version, compare against the latest (stable or nightly), download if needed, and atomically replace `bin/yt-dlp`.

Key paths and constants

- BIN_DIR: `.../bin`
- YTDLP_FINAL_PATH: `bin/yt-dlp`
- Stable asset URL: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`
- Nightly asset URL: `https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp`
- Alternative URL arrays exist for fallback; currently include the canonical URLs (mirrors can be added).
- LAST_CHECK_FILE: `bin/.last_update_check` (timestamp written after a successful update).

Options (UpdateOptions)

- `useNightly?: boolean`
- `forceUpdate?: boolean`
- `skipVersionCheck?: boolean` — when true, skips hitting the GitHub API and proceeds to download directly.

Public API

- `checkAndUpdateYtdlp(options): Promise<boolean>` — returns `true` if an update was performed successfully, `false` otherwise.
- `getUpdateStatus(): { lastCheckTime: Date | null; timeSinceLastCheck: number }` — reads timestamp from `LAST_CHECK_FILE`.

Execution flow

1) Ensure `bin/` exists.
2) If not `skipVersionCheck`, call `testGitHubApiConnectivity()` (non-fatal diagnostics: prints status, rate-limit info, or connectivity issues).
3) Determine the current version via `bin/yt-dlp --version`. If that fails, fallback to `python3 bin/yt-dlp --version` (portable script).
4) If not `skipVersionCheck`:
	- Call `getLatestYtdlpVersion(useNightly)`, which does up to 3 retries with exponential backoff against `GET /repos/{repo}/releases/latest`.
	- If unable to resolve a latest version, print suggestions and return `false`.
	- If current == latest and not `forceUpdate`, log “up to date” and return `false`.
5) Proceed to download:
	- Choose stable or nightly URL list.
	- Download to a temporary path `bin/yt-dlp.tmp` via `downloadFileWithProgressAndFallback()`.
	- `chmod 755` the temp file.
	- Atomically replace: remove existing `bin/yt-dlp` (if any) and `renameSync` temp to final.
6) Verify:
	- Read back the version (same method as step 3).
	- If `skipVersionCheck` or `forceUpdate` is true, or if the new version equals the latest tag, consider success.
	- On success, write the current timestamp to `bin/.last_update_check` and return `true`.
	- Otherwise, log mismatch and return `false`.

Networking and retries

- Downloads use Axios streams with a 30s timeout and 3 retries with exponential backoff.
- HTTP 503, 429, and timeouts produce specific guidance messages.

Progress display

- Uses the `progress` package. Progress is based on `content-length` when available.

Cleanup

- On any download failure, attempts to delete the temporary `bin/yt-dlp.tmp`.

## File paths and side effects

- All binaries live in `bin/` at the repo root.
- `bin/.last_update_check` is a timestamp file written after a successful update.
- No global/system locations are modified.

## Exit codes and logging

- `setup_binaries.ts` exits 0 on success; 1 on failure.
- `yt_dlp_update_script.ts` exits 0 for both “up to date” and non-fatal failures; exits 1 only on fatal wrapper exceptions.
- Logging is a mix of `logger.info` and console logs with clear emojis and phrases for quick scanning.

## Dependencies and environment

Runtime

- Node.js (ESM). The scripts use `fileURLToPath(import.meta.url)` for path resolution.
- `axios`, `progress` packages for downloads/UX.
- `python3` may be required at runtime to query the version of the portable script in some environments (fallback path).

External tools (ffmpeg setup only)

- `wget`, `xz`, and `tar` must be installed and available on `PATH` for the ffmpeg download pipeline.

File permissions

- The scripts `chmod 755` the downloaded executables.

Container/Alpine support

- We use the portable yt-dlp script to avoid glibc/musl issues on Alpine.

## Usage examples

NPM lifecycle

- `postinstall`: runs `src/lib/setup_binaries.ts` automatically after `npm install`.
- Manual setup: `npm run setup`.

Manual update invocations (tsx examples)

- Stable: `tsx src/lib/yt_dlp_update_script.ts`
- Nightly: `tsx src/lib/yt_dlp_update_script.ts --nightly`
- Force: `tsx src/lib/yt_dlp_update_script.ts --force`
- Skip version check: `tsx src/lib/yt_dlp_update_script.ts --skip-version-check`

Return value semantics

- If you import the engine (`update_ytdlp.ts`) and call `checkAndUpdateYtdlp`, a boolean is returned indicating whether an update was actually performed.

## How it is utilized in our pipeline

This section describes where yt-dlp is invoked at runtime and how its outputs are used. The integration is centralized in `src/lib/ytdlpWrapper.ts`.

### Primary module and binaries

- Wrapper: `src/lib/ytdlpWrapper.ts`.
- Local binaries: `bin/yt-dlp`, `bin/ffmpeg`, `bin/ffprobe` (installed by `setup_binaries.ts`, updated by the update scripts).
- Preflight guard: `checkBinaries()` ensures `yt-dlp` and `ffmpeg` exist and are executable.

### Common invocation details

- Cookies: `options.cookiesFile` or default `project/.config/yt-dlp/yt-dlp-cookies.txt` (relative paths resolved against project root).
- Headers: `options.additionalHeaders` → repeated `--add-header` flags.
- Plugins: `--plugin-dirs ./.config/yt-dlp/plugins/`.
- Extractor args: `--extractor-args youtubepot-bgutilhttp:base_url=${BGUTIL_PROVIDER_URL || http://localhost:4416}`.
- FFmpeg location: `--ffmpeg-location bin/ffmpeg` if present.
- Connections: `-N` auto-tuned via CPU or overridden by `YTDLP_CONNECTIONS`.
- Resilience: if spawning `bin/yt-dlp` fails (e.g., Alpine), fallback to `python3 bin/yt-dlp` (portable script).
- Progress: standardized progress parsing; forwarded to `options.onProgress` when provided.

### 1. Metadata fetch (no download)

- Function: `getVideoMetadata(videoUrl, options?) -> Promise<VideoMetadata>`.
- Runs `yt-dlp --dump-json` with the common flags; parses stdout JSON and returns structured metadata.

### 2. Podcast audio download (audio-only)

- Function: `downloadPodcastAudioWithProgress(videoUrl, options, metadata?) -> Promise<string>`.
- Format: selected by `getPodcastAudioFormat()` driven by `PREFERRED_AUDIO_FORMAT` (mp3/opus/aac/m4a) mapping to `bestaudio[...]` selectors.
- Output: if caller didn’t set `outputFilename` and metadata exists, uses slugged `podcast-title/episode-name.%(ext)s` under `downloads/podcasts`.
- Args: built via `buildYtdlpArgs(...)` plus `-x` to extract audio.
- Optional S3 upload via `options.s3Upload?.enabled`.

### 3. Video-only download

- Function: `downloadVideoNoAudioWithProgress(videoUrl, options, videoDefinition, metadata?) -> Promise<string>`.
- Format: bestvideo constrained by `height<=videoDefinition` with fallbacks.
- Output: defaults under `downloads/`; may use slugged path if metadata provided.

### 4. Video+audio pipeline with merge

- Function: `downloadAndMergeVideo(channelId, videoUrl, options, metadata?, channelInfo?, guestExtractionResult?) -> Promise<{ mergedFilePath: string; episodeId: string }>`.
- Flow:
	1. Pre-checks RDS (existing episode) and optionally S3 to shortcut reprocessing.
	2. Parallel downloads: video-only and audio-only to a temp directory.
	3. Merge via `mergeVideoAudioWithValidation(...)` (ffmpeg copy muxing, timestamp flags; validates output exists and non-zero size).
	4. Final path: slugged `downloads/<podcast>/<episode>/<episode>.mp4` unless caller specified `outputFilename`.
	5. Cleanup: temp files and empty directories; robust error-path cleanup.
	6. Optional S3 upload and persistence hooks.

### 5. HLS generation and playlists (ffmpeg, post-yt-dlp)

- Function: `renderingLowerDefinitionVersions(finalMergedPath, metadata, topEdition, s3Service?, bucketName?)`.
- Produces renditions (1080/720/480/360) in one ffmpeg run, ensures or writes `master.m3u8`, optionally uploads to S3, then cleans up local HLS dir.
- Helper: `writeMasterM3U8FromRenditions(outputDir, definitions)` to author a master playlist from existing variant playlists.

### Options and return values (summary)

- `DownloadOptions` commonly includes: `outputDir`, `outputFilename`, `format` (for video-only), `cookiesFile`, `additionalHeaders`, `onProgress`, and optional `s3Upload` settings.

- Returns:
	- `getVideoMetadata` → `VideoMetadata`.
	- `downloadPodcastAudioWithProgress` → audio file path.
	- `downloadVideoNoAudioWithProgress` → video file path.
	- `downloadAndMergeVideo` → `{ mergedFilePath, episodeId }`.

### Environment variables

- `PREFERRED_AUDIO_FORMAT`: podcast audio format preference (mp3 default).
- `YTDLP_CONNECTIONS`: override for `-N` connections.
- `BGUTIL_PROVIDER_URL`: injected into `--extractor-args` for custom extractor.
- `RETRY_ATTEMPTS`, `RETRY_BASE_DELAY_MS`: used by `withRetry` inside `downloadContent`.
- S3/RDS configuration: provided via environment and consumed in wrapper/service layers.

### Directory conventions

- Created/used by the wrapper: `downloads/`, `downloads/podcasts/`, `downloads/audio/`.
- Slug-based structure `podcast-title/episode-name` when metadata is available for clean organization.

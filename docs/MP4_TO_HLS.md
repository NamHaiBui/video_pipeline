# MP4 ➜ HLS (HTTP Live Streaming)

This document explains how we convert a merged MP4 into adaptive HLS renditions, what files are produced, how to run it, the FFmpeg command we build, how the master/variant m3u8 files work, and how we validate that the HLS output is correct.

## Overview

- Entry point: `renderingLowerDefinitionVersions(finalMergedPath, metadata, topEdition, s3Service?, bucketName?)` in `src/lib/ytdlpWrapper.ts`.
- Input: a final merged `*.mp4` file for an episode.
- Output (local): an `hls_output/` folder next to the MP4, containing:
	- One subfolder per rendition (e.g., `1080p/`, `720p/`, `480p/`, `360p/`).
	- Each subfolder has `<name>.m3u8` and a single fMP4 media file (byte-range HLS with `-hls_flags single_file`).
	- A top-level `master.m3u8` that references the variant playlists.
- Output (S3): the entire `hls_output/` tree is uploaded to S3 under:
	- `/{uploaderSlug}/{episodeSlug}/original/video_stream/`
	- Example: `podcast-title/episode-name/original/video_stream/master.m3u8`

## Renditions and folder layout

`topEdition` controls the highest rendition and the set we produce:

- If `topEdition = 1080`, we create: 1080p (2500k), 720p (1200k), 480p (700k), 360p (400k)
- If `topEdition = 720`, we create: 720p (1200k), 480p (700k), 360p (400k)

Local structure:

```text
<episode-dir>/
	episode.mp4
	hls_output/
		master.m3u8
		1080p/
			1080p.m3u8
			1080p.mp4 (or .m4s in some builds)  # single fMP4 media with byte ranges
		720p/
			720p.m3u8
			720p.mp4
		480p/
			480p.m3u8
			480p.mp4
		360p/
			360p.m3u8
			360p.mp4
```

Note: We use fMP4 + single-file segment mode. Players fetch by byte ranges from a single media file.

## How to run it (usage)

Typical usage inside our pipeline (simplified):

```ts
import { renderingLowerDefinitionVersions } from "../src/lib/ytdlpWrapper";
import { createS3ServiceFromEnv, getS3ArtifactBucket } from "../src/lib/s3Service";

const s3 = createS3ServiceFromEnv();
const bucket = getS3ArtifactBucket();

const { masterPlaylists3Link } = await renderingLowerDefinitionVersions(
	"/absolute/path/to/episode.mp4",
	videoMetadata,  // from yt-dlp metadata
	1080,           // or 720
	s3,
	bucket
);

console.log("Master playlist:", masterPlaylists3Link);
```

Notes:

- When S3 is provided, all HLS files are uploaded and the function returns a public `master.m3u8` URL.
- If FFmpeg fails to auto-write `master.m3u8`, we generate it manually and still upload.

## FFmpeg details (what we run and why)

We build a single FFmpeg invocation that outputs all renditions in one pass, aligning GOP/keyframes and producing HLS fMP4 byte-range playlists.

Key ideas:

- Single input: the merged MP4.
- Complex filter graph:
	- Split video once, scale to each target resolution.
	- Resample audio to 44.1kHz stereo and split to each rendition.
- Video codec: `libx264` with `-preset veryfast` and `-x264-params keyint=48:min-keyint=48:scenecut=0` to encourage aligned keyframes for better switching.
- Audio codec: `aac` at `96k`, stereo, 44.1kHz. If we hit a known AAC encoder assertion, we retry by copying the source audio stream.
- HLS muxer:
	- `-f hls -hls_segment_type fmp4 -hls_flags single_file`
	- `-hls_time 6` (target 6s segments) and `-hls_playlist_type vod`.
	- `-var_stream_map` and `-master_pl_name master.m3u8` for automatic master playlist creation.

Illustrative shape of the command we generate:

```bash
ffmpeg -hide_banner -loglevel error \
	-i "/abs/path/episode.mp4" \
	-filter_complex "[0:v]split=3[v0][v1][v2];[0:a]aresample=44100:resampler=soxr,aformat=channel_layouts=stereo:sample_fmts=fltp,asplit=3[a0][a1][a2];[v0]scale=1280x720[outv0];[v1]scale=854x480[outv1];[v2]scale=640x360[outv2]" \
	-map [outv0] -map [a0] -c:v libx264 -preset veryfast -x264-params keyint=48:min-keyint=48:scenecut=0 -b:v 1200k -c:a aac -b:a 96k -ac 2 -ar 44100 -aac_coder twoloop -avoid_negative_ts make_zero -f hls -hls_flags single_file -hls_time 6 -hls_playlist_type vod -hls_segment_type fmp4 "hls_output/720p/720p.m3u8" \
	-map [outv1] -map [a1] -c:v libx264 -preset veryfast -x264-params keyint=48:min-keyint=48:scenecut=0 -b:v 700k  -c:a aac -b:a 96k -ac 2 -ar 44100 -aac_coder twoloop -avoid_negative_ts make_zero -f hls -hls_flags single_file -hls_time 6 -hls_playlist_type vod -hls_segment_type fmp4 "hls_output/480p/480p.m3u8" \
	-map [outv2] -map [a2] -c:v libx264 -preset veryfast -x264-params keyint=48:min-keyint=48:scenecut=0 -b:v 400k  -c:a aac -b:a 96k -ac 2 -ar 44100 -aac_coder twoloop -avoid_negative_ts make_zero -f hls -hls_flags single_file -hls_time 6 -hls_playlist_type vod -hls_segment_type fmp4 "hls_output/360p/360p.m3u8" \
	-var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" -master_pl_name master.m3u8
```

Exact stream counts, bitrates, and paths depend on `topEdition` and the renditions we enable.

### Why single-file fMP4?

- Byte-range playlists reduce file counts (one media file per rendition) and simplify upload/listing.
- fMP4 is broadly supported across modern players and enables seamless bitrate switching.

## How the master m3u8 is constructed

We rely on FFmpeg’s `-var_stream_map` + `-master_pl_name` to write a compliant master. If FFmpeg doesn’t emit it (edge cases), we write it ourselves using the rendition list.

Manual generation pattern (simplified):

```text
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480p/480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"
360p/360p.m3u8
```

Notes:

- `BANDWIDTH` is in bits per second (we convert from `2500k`, `1200k`, etc.).
- `RESOLUTION` matches the scaled output.
- `CODECS` matches H.264 + AAC.
- The URI on the line after `#EXT-X-STREAM-INF` is the relative path to that rendition’s media playlist.

## How to read a variant playlist (example)

Expect fMP4 byte-range style with one media file and many `#EXT-X-BYTERANGE` entries (example only):

```text
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="720p.mp4"
#EXTINF:6.000,
#EXT-X-BYTERANGE:123456@0
720p.mp4
#EXTINF:6.000,
#EXT-X-BYTERANGE:234567@123456
720p.mp4
#EXTINF:2.000,
#EXT-X-BYTERANGE:7890@358023
720p.mp4
#EXT-X-ENDLIST
```

Key tags:

- `#EXT-X-MAP`: initialization segment for fMP4.
- `#EXTINF`: duration of each segment.
- `#EXT-X-BYTERANGE`: byte ranges into the single media file.
- `#EXT-X-ENDLIST`: VOD content end.

## Upload to S3

If `s3Service` and `bucketName` are provided, we upload the entire `hls_output/` tree. The master playlist URL becomes:

- `s3://{bucket}/{uploaderSlug}/{episodeSlug}/original/video_stream/master.m3u8`
- Public HTTPS URL is returned from `renderingLowerDefinitionVersions` via `getPublicUrl`.

## Validation: how we check correctness

Validation is performed by `ValidationService.validateAfterProcessing` and includes:

1. RDS checks
	- Episode exists; `additionalData` contains required keys like `videoLocation` and `master_m3u8`.
	- `processingDone === true` and `contentType === 'video'` for completed video flows.
2. S3 checks
	- Objects referenced by S3/HTTPS URLs exist (HEAD requests).
3. HLS master checks (when requested)
	- Fetch `master.m3u8` and ensure at least one `#EXT-X-STREAM-INF` entry exists.
	- Optionally pick the highest bandwidth variant, fetch its media playlist, and sum `#EXTINF` durations.
	- Compare HLS duration vs. episode duration (from RDS), within a configurable tolerance (e.g., 2s).

Any failures are reported in `errors[]` and we emit CloudWatch metrics for visibility.

## Tips and troubleshooting

- Master playlist missing: we auto-generate it if FFmpeg didn’t write one.
- Audio encoder assertion errors: we retry with `-c:a copy` fallback.
- Player issues: ensure CORS, correct content-types (`.m3u8` = `application/vnd.apple.mpegurl`, `.mp4`/`.m4s` = appropriate types), and HTTPS.
- Local quick test: most players (and `ffplay`) can open `master.m3u8`. For `ffplay`, ensure protocol whitelist if needed.

## Internals and helpers

- Core function: `renderingLowerDefinitionVersions`.
- Master fallback: `ensureMasterPlaylist()` inside the function and `writeMasterM3U8FromRenditions(outputDir, order)` utility.
- Command execution: `executeCommand()` with robust stderr capture and retries.

## See also

- End-to-End Pipeline Guide: `docs/Guide_to_understanding_to_process.md`
- yt-dlp setup/update/usage: `docs/YTDLP_props.md`


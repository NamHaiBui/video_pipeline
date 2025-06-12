import path from 'path';
import fs from 'fs'
import { downloadVideoAudioOnlyWithProgress, downloadVideoNoAudioWithProgress, downloadVideoWithProgress, getVideoMetadata, downloadAndMergeVideo } from './lib/ytdlpWrapper.js';
import { ProgressInfo } from './types.js';

const downloadsDir = path.resolve(process.cwd(), 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

const TEST_VIDEO_URL_1 = 'https://www.youtube.com/watch?v=C0DPdy98e4c';
const TEST_VIDEO_URL_2 = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

async function main(): Promise<void> {
    console.log('--- 1. Fetching Video Metadata ---');
    try {
        const metadata = await getVideoMetadata(TEST_VIDEO_URL_1);
        console.log('Title:', metadata.title);
        console.log('Uploader:', metadata.uploader);
        console.log('Duration:', metadata.duration);
        console.log('View Count:', metadata.view_count);
        console.log('Upload Date:', metadata.upload_date);

        const metadataFilePath = path.join(downloadsDir, `${metadata.id}_metadata.json`);
        fs.writeFileSync(
            metadataFilePath,
            JSON.stringify(metadata, null, 2),
            'utf8'
        );
        console.log(`Metadata saved to: ${metadataFilePath}`);

    } catch (error: any) {
        console.error('Error fetching metadata:', error.message);
    }

    console.log('\n--- 2. Downloading Video with Audio Merge ---');
    try {
        const downloadedFilePath = await downloadAndMergeVideo(TEST_VIDEO_URL_2, {
            outputFilename: '%(title)s [%(id)s].mp4',
            onProgress: (progress: ProgressInfo) => {
                process.stdout.write(`\rDownload Progress: ${progress.percent} | ETA: ${progress.eta} | Speed: ${progress.speed} | ${progress.raw}`);
            }
        });
        process.stdout.write('\n');
        console.log(`Video download and merge completed! Saved to: ${downloadedFilePath}`);
    } catch (error: any) {
        process.stdout.write('\n');
        console.error('Error downloading video:', error.message);
    }
}

main().catch((err: Error) => {
    console.error("\nUnhandled error in main execution:", err);
});

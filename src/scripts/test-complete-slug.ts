#!/usr/bin/env node

/**
 * Comprehensive test for slug-based filename generation
 * Tests both audio and video downloads with the podcast-title/episode-name structure
 */

import { downloadPodcastAudioWithProgress, downloadVideoNoAudioWithProgress, downloadAndMergeVideo, getVideoMetadata } from '../lib/ytdlpWrapper.js';
import { create_slug } from '../lib/utils/utils.js';
import { generateAudioS3Key, generateVideoS3Key } from '../lib/s3KeyUtils.js';
import fs from 'fs';
import path from 'path';

// Use a short test video (Rick Astley - Never Gonna Give You Up)
const TEST_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OUTPUT_DIR = path.resolve('downloads', 'test-complete-slugs');

async function testCompleteSlugBasedDownload() {
  console.log('🧪 Testing complete slug-based filename generation (audio + video)...\n');
  
  try {
    // Clean up test directory
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    
    console.log('1. Fetching metadata...');
    const metadata = await getVideoMetadata(TEST_URL);
    
    console.log(`   Title: "${metadata.title}"`);
    console.log(`   Uploader: "${metadata.uploader}"`);
    
    const expectedPodcastSlug = create_slug(metadata.uploader || '');
    const expectedEpisodeSlug = create_slug(metadata.title || '');
    const expectedPath = `${expectedPodcastSlug}/${expectedEpisodeSlug}`;
    
    console.log(`   Expected slug structure: "${expectedPath}"`);
    
    // Test S3 key generation
    const audioS3Key = generateAudioS3Key(metadata);
    const videoS3Key = generateVideoS3Key(metadata, 'mp4');
    console.log(`   Expected audio S3 key: "${audioS3Key}"`);
    console.log(`   Expected video S3 key: "${videoS3Key}"`);
    
    // Test 1: Audio-only download
    console.log('\n2. Testing audio-only download with slug naming...');
    const audioStartTime = Date.now();
    const audioDownloadedPath = await downloadPodcastAudioWithProgress(TEST_URL, {
      outputDir: OUTPUT_DIR,
      onProgress: (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r   Audio Progress: ${progress.percent} (${progress.speed || 'N/A'})`);
        }
      }
    }, metadata);
    
    const audioDuration = Date.now() - audioStartTime;
    console.log(`\n   ✅ Audio download completed in ${Math.round(audioDuration / 1000)}s`);
    console.log(`   Downloaded to: "${audioDownloadedPath}"`);
    
    // Test 2: Video-only download
    console.log('\n3. Testing video-only download with slug naming...');
    const videoStartTime = Date.now();
    const videoDownloadedPath = await downloadVideoNoAudioWithProgress(TEST_URL, {
      outputDir: OUTPUT_DIR,
      onProgress: (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r   Video Progress: ${progress.percent} (${progress.speed || 'N/A'})`);
        }
      }
    }, metadata);
    
    const videoDuration = Date.now() - videoStartTime;
    console.log(`\n   ✅ Video download completed in ${Math.round(videoDuration / 1000)}s`);
    console.log(`   Downloaded to: "${videoDownloadedPath}"`);
    
    // Test 3: Merged video+audio download
    console.log('\n4. Testing merged video+audio download with slug naming...');
    const mergeOutputDir = path.join(OUTPUT_DIR, 'merged');
    fs.mkdirSync(mergeOutputDir, { recursive: true });
    
    const mergeStartTime = Date.now();
    const { mergedFilePath } = await downloadAndMergeVideo(TEST_URL, {
      outputDir: mergeOutputDir,
      onProgress: (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r   Merge Progress: ${progress.raw} ${progress.percent || ''}`);
        }
      }
    }, metadata);
    
    const mergeDuration = Date.now() - mergeStartTime;
    console.log(`\n   ✅ Merged download completed in ${Math.round(mergeDuration / 1000)}s`);
    console.log(`   Merged file: "${mergedFilePath}"`);
    
    // Verify file structures
    console.log('\n5. Verifying file structures...');
    
    const files = [
      { path: audioDownloadedPath, type: 'Audio' },
      { path: videoDownloadedPath, type: 'Video' },
      { path: mergedFilePath, type: 'Merged' }
    ];
    
    const slugPattern = /^.*[\/\\][a-z0-9-]+[\/\\][a-z0-9-]+\.[a-z0-9]+$/;
    let allValid = true;
    
    files.forEach(file => {
      const relativePath = path.relative(OUTPUT_DIR, file.path);
      const followsPattern = slugPattern.test(file.path);
      const fileExists = fs.existsSync(file.path);
      const fileSize = fileExists ? fs.statSync(file.path).size : 0;
      
      console.log(`   ${file.type}:`);
      console.log(`     Relative path: "${relativePath}"`);
      console.log(`     Follows slug pattern: ${followsPattern ? '✅' : '❌'}`);
      console.log(`     File exists: ${fileExists ? '✅' : '❌'}`);
      console.log(`     File size: ${Math.round(fileSize / 1024)}KB`);
      
      if (!followsPattern || !fileExists || fileSize === 0) {
        allValid = false;
      }
    });
    
    // List complete directory structure
    console.log('\n6. Complete directory structure:');
    function listDirectory(dir: string, prefix: string = '') {
      const items = fs.readdirSync(dir);
      items.forEach(item => {
        const itemPath = path.join(dir, item);
        const stats = fs.statSync(itemPath);
        if (stats.isDirectory()) {
          console.log(`${prefix}📁 ${item}/`);
          listDirectory(itemPath, prefix + '  ');
        } else {
          const extension = path.extname(item);
          const emoji = extension === '.opus' ? '🎵' : extension === '.mp4' ? '🎬' : extension === '.webm' ? '📹' : '📄';
          console.log(`${prefix}${emoji} ${item} (${Math.round(stats.size / 1024)}KB)`);
        }
      });
    }
    
    listDirectory(OUTPUT_DIR, '   ');
    
    // Test S3 key consistency
    console.log('\n7. S3 Key Consistency Check:');
    const audioRelativePath = path.relative(OUTPUT_DIR, audioDownloadedPath);
    const videoRelativePath = path.relative(OUTPUT_DIR, videoDownloadedPath);
    
    // Extract the directory structure from downloaded files
    const audioDir = path.dirname(audioRelativePath);
    const videoDir = path.dirname(videoRelativePath);
    
    console.log(`   Audio directory: "${audioDir}"`);
    console.log(`   Video directory: "${videoDir}"`);
    console.log(`   Directories match: ${audioDir === videoDir ? '✅' : '❌'}`);
    console.log(`   Audio S3 key format: "${audioS3Key}"`);
    console.log(`   Video S3 key format: "${videoS3Key}"`);
    
    const s3DirConsistent = audioS3Key.includes(audioDir.replace(/\\/g, '/')) && 
                           videoS3Key.includes(videoDir.replace(/\\/g, '/'));
    console.log(`   S3 keys consistent with local structure: ${s3DirConsistent ? '✅' : '❌'}`);
    
    console.log('\n8. Test Results Summary:');
    console.log(`   ✅ Metadata fetched successfully`);
    console.log(`   ✅ Audio download completed successfully`);
    console.log(`   ✅ Video download completed successfully`);
    console.log(`   ✅ Merged download completed successfully`);
    console.log(`   ${allValid ? '✅' : '❌'} All files follow slug pattern`);
    console.log(`   ${allValid ? '✅' : '❌'} All files exist with content`);
    console.log(`   ${s3DirConsistent ? '✅' : '❌'} S3 keys consistent with local structure`);
    
    if (allValid && s3DirConsistent) {
      console.log('\n🎉 All tests passed! Complete slug-based filename generation is working correctly.');
      console.log('📁 Local files use podcast-title/episode-name structure');
      console.log('☁️  S3 keys follow the same consistent pattern');
      console.log('🔄 Both audio and video downloads work with the new naming system');
    } else {
      console.log('\n❌ Some tests failed. Please check the implementation.');
    }
    
  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.stderrContent) {
      console.error('Error details:', error.stderrContent);
    }
  } finally {
    // Optional: Clean up test files
    // if (fs.existsSync(OUTPUT_DIR)) {
    //   fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    //   console.log('\n🧹 Cleaned up test files');
    // }
  }
}

testCompleteSlugBasedDownload();

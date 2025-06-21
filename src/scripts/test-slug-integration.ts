#!/usr/bin/env node

/**
 * Integration test for slug-based filename generation
 * Tests the actual download process with a short test video
 */

import { downloadPodcastAudioWithProgress, getVideoMetadata } from '../lib/ytdlpWrapper.js';
import { create_slug } from '../lib/utils/utils.js';
import fs from 'fs';
import path from 'path';

// Use a short test video (Rick Astley - Never Gonna Give You Up)
const TEST_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OUTPUT_DIR = path.resolve('downloads', 'test-slugs');

async function testSlugBasedDownload() {
  console.log('🧪 Testing slug-based filename generation with actual download...\n');
  
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
    
    console.log('\n2. Starting download with slug-based naming...');
    
    const startTime = Date.now();
    const downloadedPath = await downloadPodcastAudioWithProgress(TEST_URL, {
      outputDir: OUTPUT_DIR,
      onProgress: (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r   Progress: ${progress.percent} (${progress.speed || 'N/A'})`);
        }
      }
    }, metadata);
    
    const duration = Date.now() - startTime;
    console.log(`\n   ✅ Download completed in ${Math.round(duration / 1000)}s`);
    console.log(`   Downloaded to: "${downloadedPath}"`);
    
    // Verify the file structure
    console.log('\n3. Verifying file structure...');
    
    const relativePath = path.relative(OUTPUT_DIR, downloadedPath);
    console.log(`   Relative path: "${relativePath}"`);
    
    // Check if file follows expected slug pattern
    const slugPattern = /^[a-z0-9-]+\/[a-z0-9-]+\.[a-z0-9]+$/;
    const followsPattern = slugPattern.test(relativePath);
    
    console.log(`   Follows slug pattern: ${followsPattern ? '✅' : '❌'}`);
    
    // Check if file exists and has content
    const fileExists = fs.existsSync(downloadedPath);
    const fileSize = fileExists ? fs.statSync(downloadedPath).size : 0;
    
    console.log(`   File exists: ${fileExists ? '✅' : '❌'}`);
    console.log(`   File size: ${Math.round(fileSize / 1024)}KB`);
    
    // List directory structure
    console.log('\n4. Directory structure:');
    function listDirectory(dir: string, prefix: string = '') {
      const items = fs.readdirSync(dir);
      items.forEach(item => {
        const itemPath = path.join(dir, item);
        const stats = fs.statSync(itemPath);
        if (stats.isDirectory()) {
          console.log(`${prefix}📁 ${item}/`);
          listDirectory(itemPath, prefix + '  ');
        } else {
          console.log(`${prefix}📄 ${item} (${Math.round(stats.size / 1024)}KB)`);
        }
      });
    }
    
    listDirectory(OUTPUT_DIR, '   ');
    
    console.log('\n5. Test Results:');
    console.log(`   ✅ Metadata fetched successfully`);
    console.log(`   ✅ Download completed successfully`);
    console.log(`   ${followsPattern ? '✅' : '❌'} Filename follows slug pattern`);
    console.log(`   ${fileExists ? '✅' : '❌'} File exists`);
    console.log(`   ${fileSize > 0 ? '✅' : '❌'} File has content`);
    
    if (followsPattern && fileExists && fileSize > 0) {
      console.log('\n🎉 All tests passed! Slug-based filename generation is working correctly.');
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

testSlugBasedDownload();

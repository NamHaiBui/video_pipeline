import { downloadPodcastAudioWithProgress, downloadVideoNoAudioWithProgress, downloadAndMergeVideo, getVideoMetadata } from '../lib/ytdlpWrapper.js';
import { generateAudioS3Key, generateVideoS3Key } from '../lib/s3KeyUtils.js';
import { create_slug } from '../lib/utils/utils.js';
import * as fs from 'fs';
import * as path from 'path';

interface TestCase {
  title: string;
  url: string;
  expectedSlug: string;
}

const testCases: TestCase[] = [
  {
    title: 'Short video test',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    expectedSlug: 'rick-astley/rick-astley-never-gonna-give-you-up'
  },
  {
    title: 'Video with special characters',
    url: 'https://www.youtube.com/watch?v=54wNtMZF_sg',
    expectedSlug: 'all-in-podcast/all-in-live-from-austin-colin-and-samir-chris-williamson-and-bryan-johnson'
  }
];

async function testVideoSlugNaming() {
  console.log('🎬 Testing video slug-based naming...\n');

  for (const testCase of testCases) {
    console.log(`📹 Testing: ${testCase.title}`);
    console.log(`🔗 URL: ${testCase.url}`);
    console.log(`📝 Expected slug pattern: ${testCase.expectedSlug}`);

    try {
      // Get metadata first
      const metadata = await getVideoMetadata(testCase.url);
      console.log(`📋 Got metadata for: ${metadata.title}`);

      // Test video download
      console.log('\n🎥 Testing video download...');
      const videoOutputPath = await downloadVideoNoAudioWithProgress(testCase.url, {}, metadata);
      
      console.log(`✅ Video downloaded to: ${videoOutputPath}`);
      
      // Check if file exists
      if (fs.existsSync(videoOutputPath)) {
        console.log(`✅ Video file exists on disk`);
        
        // Verify slug structure in path
        const relativePath = path.relative(process.cwd(), videoOutputPath);
        console.log(`📂 Relative path: ${relativePath}`);
        
        // Check if path contains expected slug pattern
        if (relativePath.includes('/')) {
          const pathParts = relativePath.split('/');
          console.log(`📁 Path structure: ${pathParts.join(' → ')}`);
          
          // Should have format: downloads/podcasts/podcast-title/episode-name.ext
          if (pathParts.length >= 3 && pathParts[0] === 'downloads' && pathParts[1] === 'podcasts') {
            console.log(`✅ Correct directory structure (downloads/podcasts/...)`);
          } else {
            console.log(`❌ Incorrect directory structure`);
          }
        }
        
        // Test S3 key generation
        console.log('\n🔑 Testing S3 key generation...');
        const s3Key = generateVideoS3Key(metadata, path.extname(videoOutputPath));
        console.log(`🔑 Generated S3 key: ${s3Key}`);
        
        // Verify S3 key format
        if (s3Key.includes('/')) {
          console.log(`✅ S3 key has correct format`);
        } else {
          console.log(`❌ S3 key format incorrect`);
        }
        
      } else {
        console.log(`❌ Video file not found on disk`);
      }

      // Test audio download for comparison
      console.log('\n🎵 Testing audio download for comparison...');
      const audioOutputPath = await downloadPodcastAudioWithProgress(testCase.url, {}, metadata);
      
      console.log(`✅ Audio downloaded to: ${audioOutputPath}`);
      
      // Generate S3 key for audio
      const audioS3Key = generateAudioS3Key(metadata);
      console.log(`🔑 Audio S3 key: ${audioS3Key}`);

      // Test merged video download
      console.log('\n🎬 Testing merged video+audio download...');
      const mergedResult = await downloadAndMergeVideo(testCase.url, {}, metadata);
      
      console.log(`✅ Merged video downloaded to: ${mergedResult.mergedFilePath}`);
      
      // Check file exists
      if (fs.existsSync(mergedResult.mergedFilePath)) {
        console.log(`✅ Merged video file exists on disk`);
        
        // Generate S3 key for merged video
        const mergedS3Key = generateVideoS3Key(metadata, path.extname(mergedResult.mergedFilePath));
        console.log(`🔑 Merged video S3 key: ${mergedS3Key}`);
      }

      console.log('\n' + '='.repeat(80) + '\n');
      
    } catch (error) {
      console.error(`❌ Error testing ${testCase.title}:`, error);
      console.log('\n' + '='.repeat(80) + '\n');
    }
  }
}

async function testSlugGeneration() {
  console.log('🏷️  Testing slug generation for various titles...\n');

  const testTitles = [
    'Rick Astley - Never Gonna Give You Up (Official Video)',
    'All-In Live from Austin: Colin and Samir, Chris Williamson, and Bryan Johnson',
    'The Joe Rogan Experience #1234 - Guest Name',
    'Podcast Title: Episode with Special Characters! & More',
    'Very Long Podcast Title That Should Be Truncated Properly and Handled Gracefully',
    'Title with "Quotes" and [Brackets] (Parentheses)',
  ];

  testTitles.forEach(title => {
    const slug = create_slug(title);
    console.log(`📝 Title: ${title}`);
    console.log(`🏷️  Slug:  ${slug}`);
    console.log(`📏 Length: ${slug.length} characters\n`);
  });
}

async function main() {
  console.log('🚀 Starting comprehensive video slug testing...\n');
  
  // Test slug generation
  await testSlugGeneration();
  
  console.log('='.repeat(80) + '\n');
  
  // Test actual video downloads
  await testVideoSlugNaming();
  
  console.log('✅ Video slug testing completed!');
}

// Run main function
main().catch(console.error);

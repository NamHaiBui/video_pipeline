#!/usr/bin/env node

/**
 * yt-dlp Warning Diagnostics Script
 * 
 * This script helps diagnose yt-dlp warnings by testing with a sample video
 * and showing exactly what stderr messages are being generated.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

// Sample YouTube URL for testing (short video)
const TEST_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

async function diagnoseYtDlpWarnings() {
  console.log('🔍 yt-dlp Warning Diagnostics');
  console.log('=' .repeat(50));
  
  const binPath = path.resolve(process.cwd(), 'bin', 'yt-dlp');
  
  try {
    // Test 1: Check yt-dlp version
    console.log('\n📋 Test 1: yt-dlp Version Check');
    console.log('-'.repeat(30));
    
    try {
      const { stdout: version, stderr: versionStderr } = await execAsync(`${binPath} --version`);
      console.log(`✅ Version: ${version.trim()}`);
      if (versionStderr) {
        console.log(`⚠️  Version check stderr: ${versionStderr.trim()}`);
      }
    } catch (error: any) {
      console.error(`❌ Version check failed: ${error.message}`);
    }
    
    // Test 2: Metadata extraction test
    console.log('\n📋 Test 2: Metadata Extraction Test');
    console.log('-'.repeat(30));
    
    try {
      const command = `${binPath} --dump-json --no-warnings "${TEST_URL}"`;
      console.log(`Command: ${command}`);
      
      const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
      
      if (stderr) {
        console.log('\n  Stderr Output:');
        const stderrLines = stderr.split('\n').filter(line => line.trim());
        stderrLines.forEach((line, index) => {
          console.log(`  ${index + 1}: ${line}`);
          
          // Analyze the line
          const lowerLine = line.toLowerCase();
          const isInfo = lowerLine.includes('downloading') || 
                        lowerLine.includes('extracting') || 
                        lowerLine.includes('[youtube]');
          const isWarning = lowerLine.includes('warning') || 
                           lowerLine.includes('error') || 
                           lowerLine.includes('failed');
          
          if (isWarning && !isInfo) {
            console.log(`    🚨 CATEGORIZED AS: WARNING`);
          } else if (isInfo) {
            console.log(`    ℹ️  CATEGORIZED AS: INFO`);
          } else {
            console.log(`    ❓ CATEGORIZED AS: UNKNOWN`);
          }
        });
      } else {
        console.log('✅ No stderr output');
      }
      
      if (stdout) {
        try {
          const metadata = JSON.parse(stdout);
          console.log(`✅ Metadata extracted successfully for: ${metadata.title}`);
        } catch (jsonError) {
          console.log('⚠️  Could not parse JSON metadata');
        }
      }
      
    } catch (error: any) {
      console.error(`❌ Metadata test failed: ${error.message}`);
      if (error.stderr) {
        console.log(`Stderr: ${error.stderr}`);
      }
    }
    
    // Test 3: Common warning patterns
    console.log('\n📋 Test 3: Warning Pattern Analysis');
    console.log('-'.repeat(30));
    
    const testMessages = [
      'WARNING: This is a test warning',
      'ERROR: Connection failed',
      '[youtube] Extracting video info',
      'Downloading webpage',
      'Failed to download video',
      'Video unavailable',
      'Selected format: mp4',
      'Destination: /tmp/video.mp4'
    ];
    
    testMessages.forEach(message => {
      const lowerMessage = message.toLowerCase();
      
      const isInformational = lowerMessage.includes('downloading') ||
                             lowerMessage.includes('extracting') ||
                             lowerMessage.includes('[youtube]') ||
                             lowerMessage.includes('selected format') ||
                             lowerMessage.includes('destination:');
      
      const isWarning = lowerMessage.includes('error') ||
                       lowerMessage.includes('warning') ||
                       lowerMessage.includes('failed') ||
                       lowerMessage.includes('unavailable');
      
      const shouldLog = isWarning && !isInformational;
      
      console.log(`Message: "${message}"`);
      console.log(`  - Is Warning: ${isWarning}`);
      console.log(`  - Is Informational: ${isInformational}`);
      console.log(`  - Should Log: ${shouldLog ? '🚨 YES' : '✅ NO'}`);
      console.log('');
    });
    
  } catch (error: any) {
    console.error('❌ Diagnostics failed:', error.message);
  }
  
  console.log('\n💡 Tips:');
  console.log('- Set YTDLP_VERBOSE_WARNINGS=true to see all yt-dlp messages');
  console.log('- Set LOG_LEVEL=debug to see debug information');
  console.log('- Check your internet connection if getting network errors');
  console.log('- Update yt-dlp if getting compatibility warnings');
}

// Run diagnostics if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  diagnoseYtDlpWarnings().catch(console.error);
}

export { diagnoseYtDlpWarnings };

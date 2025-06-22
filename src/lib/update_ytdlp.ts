import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import axios, { AxiosResponse } from 'axios';
import ProgressBar from 'progress';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const YTDLP_FINAL_PATH = path.join(BIN_DIR, 'yt-dlp');
const YTDLP_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const YTDLP_NIGHTLY_URL = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux';

// Alternative download URLs (mirrors/fallbacks)
const YTDLP_ALTERNATIVE_URLS = {
  stable: [
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
    // Add more mirrors here if available
  ],
  nightly: [
    'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux',
    // Add more mirrors here if available
  ]
};

const LAST_CHECK_FILE = path.join(BIN_DIR, '.last_update_check');

// Configuration - Periodic checks removed for cloud deployment
// Update checks will be handled via container orchestration or manual triggers

export interface UpdateOptions {
  useNightly?: boolean;
  forceUpdate?: boolean;
  skipVersionCheck?: boolean; // Allow updating without version check
}

/**
 * Test GitHub API connectivity and rate limit status
 */
async function testGitHubApiConnectivity(): Promise<void> {
  try {
    console.log('🔍 Testing GitHub API connectivity...');
    
    const response = await axios.get('https://api.github.com/rate_limit', {
      timeout: 5000,
      headers: {
        'User-Agent': 'video-pipeline/1.0.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const rateLimit = response.data.rate;
    console.log(`✅ GitHub API is accessible`);
    
    if (rateLimit.remaining === 0) {
      console.warn('⚠️ GitHub API rate limit exceeded!');
      const resetTime = new Date(rateLimit.reset * 1000);
      const now = new Date();
      const minutesUntilReset = Math.ceil((resetTime.getTime() - now.getTime()) / (1000 * 60));
      console.log(`⏰ Rate limit will reset in ${minutesUntilReset} minutes`);
    }
    
  } catch (error: any) {
    if (error.response?.status === 503) {
      console.error('❌ GitHub API is currently unavailable (503 Service Unavailable)');
    } else if (error.code === 'ECONNABORTED') {
      console.error('❌ Connection to GitHub API timed out');
    } else {
      console.error('❌ GitHub API connectivity test failed:', error.message);
    }
  }
}

/**
 * Get the current version of yt-dlp
 */
function getCurrentYtdlpVersion(): string | null {
  try {
    if (!fs.existsSync(YTDLP_FINAL_PATH)) {
      return null;
    }
    
    const version = execSync(`"${YTDLP_FINAL_PATH}" --version`, { encoding: 'utf-8' }).trim();
    return version;
  } catch (error) {
    console.warn('Failed to get current yt-dlp version:', error);
    return null;
  }
}

/**
 * Get the latest version of yt-dlp from GitHub API with retry logic
 */
async function getLatestYtdlpVersion(useNightly = false): Promise<string | null> {
  const repo = useNightly ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
  const versionType = useNightly ? 'nightly' : 'stable';
  
  // Retry configuration
  const maxRetries = 3;
  const retryDelay = 2000; // 2 seconds
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔍 Fetching latest ${versionType} version...`);
      
      const response = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, {
        timeout: 10000, // 10 second timeout
        headers: {
          'User-Agent': 'video-pipeline/1.0.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      
      if (response.data && response.data.tag_name) {
        console.log(`✅ Latest ${versionType} version: ${response.data.tag_name}`);
        return response.data.tag_name;
      } else {
        throw new Error('Invalid response structure: missing tag_name');
      }
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      
      if (error.response?.status === 503) {
        console.warn(`⚠️ GitHub API temporarily unavailable (503) for ${versionType} version (attempt ${attempt}/${maxRetries})`);
      } else if (error.response?.status === 403) {
        console.warn(`⚠️ GitHub API rate limit exceeded (403) for ${versionType} version (attempt ${attempt}/${maxRetries})`);
      } else if (error.code === 'ECONNABORTED') {
        console.warn(`⚠️ Request timeout for ${versionType} version (attempt ${attempt}/${maxRetries})`);
      } else {
        console.warn(`⚠️ Failed to fetch ${versionType} version: ${error.message} (attempt ${attempt}/${maxRetries})`);
      }
      
      if (isLastAttempt) {
        console.error(`❌ Failed to fetch latest yt-dlp version (${versionType}) after ${maxRetries} attempts:`, error.message);
        
        // Provide fallback suggestion
        if (error.response?.status === 503 || error.response?.status === 403) {
          console.log(`💡 Suggestion: Try again later as GitHub API might be temporarily unavailable or rate-limited`);
        }
        
        return null;
      }
      
      // Wait before retrying (with exponential backoff)
      const delay = retryDelay * Math.pow(2, attempt - 1);
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return null;
}

/**
 * Get the last update check timestamp
 */
function getLastUpdateCheck(): number {
  try {
    if (fs.existsSync(LAST_CHECK_FILE)) {
      const timestamp = fs.readFileSync(LAST_CHECK_FILE, 'utf-8').trim();
      return parseInt(timestamp, 10) || 0;
    }
  } catch (error) {
    console.warn('Failed to read last update check timestamp:', error);
  }
  return 0;
}

/**
 * Save the current timestamp as last update check
 */
function saveLastUpdateCheck(): void {
  try {
    fs.writeFileSync(LAST_CHECK_FILE, Date.now().toString());
  } catch (error) {
    console.warn('Failed to save last update check timestamp:', error);
  }
}

// Removed for cloud deployment - update checks handled by orchestration

/**
 * Download file with progress bar and retry logic, trying multiple URLs
 */
async function downloadFileWithProgressAndFallback(urls: string[], outputPath: string, fileNameForProgress: string): Promise<void> {
  let lastError: Error | null = null;
  
  for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
    const url = urls[urlIndex];
    const isLastUrl = urlIndex === urls.length - 1;
    
    try {
      console.log(`📥 Trying download source ${urlIndex + 1}/${urls.length} for ${fileNameForProgress}...`);
      await downloadFileWithProgress(url, outputPath, fileNameForProgress);
      return; // Success, exit
    } catch (error: any) {
      lastError = error;
      console.warn(`❌ Download source ${urlIndex + 1} failed: ${error.message}`);
      
      if (!isLastUrl) {
        console.log(`🔄 Trying next download source...`);
      }
    }
  }
  
  // If we get here, all URLs failed
  console.error(`❌ All download sources failed for ${fileNameForProgress}`);
  throw lastError || new Error('All download sources failed');
}

/**
 * Download file with progress bar and retry logic
 */
async function downloadFileWithProgress(url: string, outputPath: string, fileNameForProgress: string): Promise<void> {
  console.log(`Downloading ${fileNameForProgress} from ${url} to ${outputPath}...`);
  
  const maxRetries = 3;
  const retryDelay = 3000; // 3 seconds
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📥 Download attempt ${attempt}/${maxRetries} for ${fileNameForProgress}...`);
      
      const response: AxiosResponse = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'video-pipeline/1.0.0',
          'Accept': 'application/octet-stream',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      });

      const { data, headers } = response;
      const totalLength = headers['content-length'];
      const progressBar = new ProgressBar(`-> ${fileNameForProgress} [:bar] :percent :etas`, {
        width: 40,
        complete: '=',
        incomplete: ' ',
        renderThrottle: 100,
        total: parseInt(totalLength as string) || 0,
      });

      const writer = fs.createWriteStream(outputPath);
      data.on('data', (chunk: Buffer) => {
        if (totalLength) {
          progressBar.tick(chunk.length);
        }
      });
      data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });
      
      console.log(`✅ Successfully downloaded ${fileNameForProgress}`);
      return; // Success, exit retry loop
      
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      
      if (error.response?.status === 503) {
        console.warn(`⚠️ GitHub servers temporarily unavailable (503) for ${fileNameForProgress} (attempt ${attempt}/${maxRetries})`);
      } else if (error.response?.status === 429) {
        console.warn(`⚠️ Rate limited (429) for ${fileNameForProgress} (attempt ${attempt}/${maxRetries})`);
      } else if (error.code === 'ECONNABORTED') {
        console.warn(`⚠️ Download timeout for ${fileNameForProgress} (attempt ${attempt}/${maxRetries})`);
      } else {
        console.warn(`⚠️ Download failed for ${fileNameForProgress}: ${error.message} (attempt ${attempt}/${maxRetries})`);
      }
      
      if (isLastAttempt) {
        console.error(`❌ Failed to download ${fileNameForProgress} after ${maxRetries} attempts`);
        
        // Provide fallback suggestions
        if (error.response?.status === 503) {
          console.log(`💡 GitHub servers appear to be under heavy load. Consider:`);
          console.log(`   - Trying again in a few minutes`);
          console.log(`   - Checking GitHub status at https://www.githubstatus.com/`);
        } else if (error.response?.status === 429) {
          console.log(`💡 Rate limit exceeded. Try again later.`);
        }
        
        throw error;
      }
      
      // Wait before retrying (with exponential backoff)
      const delay = retryDelay * Math.pow(2, attempt - 1);
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Update yt-dlp to the latest version
 */
async function updateYtdlp(options: UpdateOptions = {}): Promise<boolean> {
  const { useNightly = false, forceUpdate = false, skipVersionCheck = false } = options;
  
  const currentVersion = getCurrentYtdlpVersion();
  const versionType = useNightly ? 'nightly' : 'stable';
  
  let latestVersion: string | null = null;
  
  if (!skipVersionCheck) {
    latestVersion = await getLatestYtdlpVersion(useNightly);
    
    if (!latestVersion) {
      console.error(`❌ Failed to fetch latest version information (${versionType})`);
      console.log(`💡 You can bypass version checking by using --skip-version-check flag`);
      console.log(`💡 Or try again later if GitHub API is temporarily unavailable`);
      return false;
    }
    
    console.log(`📋 Current version: ${currentVersion || 'Not installed'}`);
    console.log(`📋 Latest ${versionType} version: ${latestVersion}`);

    // If current version matches latest and not forcing update, no update needed
    if (!forceUpdate && currentVersion === latestVersion) {
      console.log(`✅ yt-dlp is already up to date (${versionType})`);
      return false;
    }
  } else {
    console.log(`⚠️ Skipping version check, proceeding with ${versionType} update...`);
    console.log(`📋 Current version: ${currentVersion || 'Not installed'}`);
  }

  console.log(`🔄 ${skipVersionCheck ? 'Downloading' : 'Update available, downloading'} latest ${versionType} version...`);

  try {
    // Create temporary download path
    const tempPath = YTDLP_FINAL_PATH + '.tmp';
    
    // Choose the correct download URLs based on version type
    const downloadUrls = useNightly ? YTDLP_ALTERNATIVE_URLS.nightly : YTDLP_ALTERNATIVE_URLS.stable;
    
    // Download latest version with fallback URLs
    await downloadFileWithProgressAndFallback(downloadUrls, tempPath, `yt-dlp (${versionType})`);
    
    // Make executable
    fs.chmodSync(tempPath, '755');
    
    // Replace old version with new one
    if (fs.existsSync(YTDLP_FINAL_PATH)) {
      fs.unlinkSync(YTDLP_FINAL_PATH);
    }
    fs.renameSync(tempPath, YTDLP_FINAL_PATH);
    
    // Verify the update
    const newVersion = getCurrentYtdlpVersion();
    if (skipVersionCheck || forceUpdate || newVersion === latestVersion) {
      console.log(`✅ yt-dlp successfully updated to ${versionType} version ${newVersion || 'unknown'}`);
      
      // Save the timestamp of successful update
      saveLastUpdateCheck();
      return true;
    } else {
      console.error(`❌ Update verification failed. Expected: ${latestVersion}, Got: ${newVersion}`);
      return false;
    }
    
  } catch (error: any) {
    console.error(`❌ Failed to update yt-dlp (${versionType}):`, error.message);
    
    // Clean up temporary file if it exists
    try {
      const tempPath = YTDLP_FINAL_PATH + '.tmp';
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (cleanupError) {
      console.warn('Warning: Failed to clean up temporary file:', cleanupError);
    }
    
    return false;
  }
}

/**
 * Check for updates and update if available
 */
export async function checkAndUpdateYtdlp(options: UpdateOptions = {}): Promise<boolean> {
  const { useNightly = false, forceUpdate = false, skipVersionCheck = false } = options;
  
  console.log(`🔍 Checking for yt-dlp updates (${useNightly ? 'nightly' : 'stable'})...`);
  
  // Ensure bin directory exists
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  // Test GitHub API connectivity first if not skipping version check
  if (!skipVersionCheck) {
    await testGitHubApiConnectivity();
  }

  try {
    const wasUpdated = await updateYtdlp(options);
    return wasUpdated;
  } catch (error: any) {
    console.error('❌ Error during yt-dlp update check:', error.message);
    return false;
  }
}

// Removed periodic update check functionality for cloud deployment
// Update checks will be handled via:
// 1. Container orchestration (ECS task definitions with updated images)
// 2. Manual API calls via /api/update-ytdlp endpoint
// 3. CI/CD pipeline triggers

/**
 * Get update status information (simplified without periodic checks)
 */
export function getUpdateStatus(): {
  lastCheckTime: Date | null;
  timeSinceLastCheck: number;
} {
  const lastCheck = getLastUpdateCheck();
  
  return {
    lastCheckTime: lastCheck > 0 ? new Date(lastCheck) : null,
    timeSinceLastCheck: lastCheck > 0 ? Date.now() - lastCheck : 0
  };
}

// Direct execution disabled when imported as a module
// Uncomment this section only when running the script directly

/*
// Check if this script is being run directly (not imported)
function isMainModule(): boolean {
  try {
    // Check if we're the main module by comparing the resolved paths
    const mainPath = path.resolve(process.argv[1]);
    const currentPath = path.resolve(__filename);
    return mainPath === currentPath;
  } catch {
    return false;
  }
}

// If this script is run directly (not imported as a module)
if (isMainModule()) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const useNightly = args.includes('--nightly') || args.includes('-n');
  const forceUpdate = args.includes('--force') || args.includes('-f');
  const periodicMode = args.includes('--periodic') || args.includes('-p');
  
  const options: UpdateOptions = {
    useNightly,
    forceUpdate,
    enablePeriodicChecks: periodicMode
  };

  if (periodicMode) {
    console.log('🕐 Starting in periodic mode...');
    startPeriodicUpdateChecks(options);
    
    // Keep the process running
    process.on('SIGINT', () => {
      console.log('\n🛑 Received interrupt signal, stopping periodic checks...');
      stopPeriodicUpdateChecks();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.log('\n🛑 Received termination signal, stopping periodic checks...');
      stopPeriodicUpdateChecks();
      process.exit(0);
    });
    
    console.log('✨ Periodic update checks started. Press Ctrl+C to stop.');
  } else {
    // Single run mode
    checkAndUpdateYtdlp(options)
      .then((wasUpdated) => {
        if (wasUpdated) {
          console.log('🎉 yt-dlp update completed successfully');
        } else {
          console.log('ℹ️ No update was needed or update failed');
        }
        process.exit(0);
      })
      .catch((error) => {
        console.error('💥 Fatal error during update check:', error);
        process.exit(1);
      });
  }
}
*/

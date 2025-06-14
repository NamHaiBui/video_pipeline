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
const LAST_CHECK_FILE = path.join(BIN_DIR, '.last_update_check');

// Configuration - Periodic checks removed for cloud deployment
// Update checks will be handled via container orchestration or manual triggers

export interface UpdateOptions {
  useNightly?: boolean;
  forceUpdate?: boolean;
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
 * Get the latest version of yt-dlp from GitHub API
 */
async function getLatestYtdlpVersion(useNightly = false): Promise<string | null> {
  try {
    const repo = useNightly ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
    const response = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`);
    return response.data.tag_name;
  } catch (error: any) {
    console.error(`Failed to fetch latest yt-dlp version (${useNightly ? 'nightly' : 'stable'}):`, error.message);
    return null;
  }
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
 * Download file with progress bar
 */
async function downloadFileWithProgress(url: string, outputPath: string, fileNameForProgress: string): Promise<void> {
  console.log(`Downloading ${fileNameForProgress} from ${url} to ${outputPath}...`);
  try {
    const response: AxiosResponse = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
    });

    const { data, headers } = response;
    const totalLength = headers['content-length'];
    const progressBar = new ProgressBar(`-> ${fileNameForProgress} [:bar] :percent :etas`, {
      width: 40,
      complete: '=',
      incomplete: ' ',
      renderThrottle: 100,
      total: parseInt(totalLength as string),
    });

    const writer = fs.createWriteStream(outputPath);
    data.on('data', (chunk: Buffer) => progressBar.tick(chunk.length));
    data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error: any) {
    console.error(`Error downloading ${fileNameForProgress}: ${error.message}`);
    throw error;
  }
}

/**
 * Update yt-dlp to the latest version
 */
async function updateYtdlp(options: UpdateOptions = {}): Promise<boolean> {
  const { useNightly = false, forceUpdate = false } = options;
  
  const currentVersion = getCurrentYtdlpVersion();
  const latestVersion = await getLatestYtdlpVersion(useNightly);

  if (!latestVersion) {
    console.error(`❌ Failed to fetch latest version information (${useNightly ? 'nightly' : 'stable'})`);
    return false;
  }

  const versionType = useNightly ? 'nightly' : 'stable';
  console.log(`📋 Current version: ${currentVersion || 'Not installed'}`);
  console.log(`📋 Latest ${versionType} version: ${latestVersion}`);

  // If current version matches latest and not forcing update, no update needed
  if (!forceUpdate && currentVersion === latestVersion) {
    console.log(`✅ yt-dlp is already up to date (${versionType})`);
    return false;
  }

  console.log(`🔄 Update available, downloading latest ${versionType} version...`);

  try {
    // Create temporary download path
    const tempPath = YTDLP_FINAL_PATH + '.tmp';
    
    // Choose the correct download URL based on version type
    const downloadUrl = useNightly ? YTDLP_NIGHTLY_URL : YTDLP_RELEASE_URL;
    
    // Download latest version
    await downloadFileWithProgress(downloadUrl, tempPath, `yt-dlp (${versionType})`);
    
    // Make executable
    fs.chmodSync(tempPath, '755');
    
    // Replace old version with new one
    if (fs.existsSync(YTDLP_FINAL_PATH)) {
      fs.unlinkSync(YTDLP_FINAL_PATH);
    }
    fs.renameSync(tempPath, YTDLP_FINAL_PATH);
    
    // Verify the update
    const newVersion = getCurrentYtdlpVersion();
    if (newVersion === latestVersion || forceUpdate) {
      console.log(`✅ yt-dlp successfully updated to ${versionType} version ${newVersion}`);
      
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
  const { useNightly = false, forceUpdate = false } = options;
  
  console.log(`🔍 Checking for yt-dlp updates (${useNightly ? 'nightly' : 'stable'})...`);
  
  // Ensure bin directory exists
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
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

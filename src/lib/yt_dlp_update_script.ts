import { checkAndUpdateYtdlp, UpdateOptions } from './update_ytdlp.js';

// Parse command line arguments
const args = process.argv.slice(2);
const useNightly = args.includes('--nightly') || args.includes('-n');
const forceUpdate = args.includes('--force') || args.includes('-f');
const skipVersionCheck = args.includes('--skip-version-check') || args.includes('-s');

const options: UpdateOptions = {
  useNightly,
  forceUpdate,
  skipVersionCheck
};

console.log('🚀 Starting yt-dlp update script...');
console.log(`📋 Options: ${JSON.stringify(options, null, 2)}`);

// Handle process signals for graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received interrupt signal, stopping...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received termination signal, stopping...');
  process.exit(0);
});

// Main execution
async function main() {
  try {
    const wasUpdated = await checkAndUpdateYtdlp(options);
    
    if (wasUpdated) {
      console.log('🎉 yt-dlp update completed successfully');
      process.exit(0);
    } else {
      console.log('ℹ️ No update was needed or update failed');
      // If skipVersionCheck was used and update failed, suggest trying without it
      if (skipVersionCheck) {
        console.log('💡 If this was due to download issues, try running without --skip-version-check');
      } else {
        console.log('💡 If GitHub API is unavailable, try with --skip-version-check flag');
      }
      process.exit(0);
    }
  } catch (error: any) {
    console.error('💥 Fatal error during update check:', error.message);
    // Provide helpful suggestions based on error type
    if (error.message.includes('503') || error.message.includes('Service Unavailable')) {
      console.log('💡 GitHub API appears to be unavailable. Try again later or use --skip-version-check');
    } else if (error.message.includes('403') || error.message.includes('rate limit')) {
      console.log('💡 GitHub API rate limit exceeded. Try again later or use --skip-version-check');
    } else if (error.message.includes('ECONNABORTED') || error.message.includes('timeout')) {
      console.log('💡 Network timeout occurred. Check your internet connection or try --skip-version-check');
    }
    
    process.exit(1);
  }
}

main();

# EPHEMERAL S3 STORAGE IMPLEMENTATION

## Summary of Changes Made

### 1. Added video_url Field to Podcast Episodes
- **File**: `src/types.ts` 
- **Change**: Added optional `video_url?: string` field to `PodcastEpisodeData` interface
- **Purpose**: Store S3 URL for video files in podcast episode records

### 2. Updated DynamoDB Service
- **File**: `src/lib/dynamoService.ts`
- **Changes**:
  - Modified `convertAndSaveAsPodcastEpisode()` method signature to accept optional `videoUrl` parameter
  - Updated `convertVideoToPodcastEpisode()` private method to handle video URL
  - Set `video_url` field in podcast episode data structure to use S3 URL
- **Purpose**: Enable storage of both audio and video S3 URLs in podcast episodes

### 3. Enhanced Server Processing Logic
- **File**: `src/server.ts`
- **Changes**:
  - Modified podcast conversion logic to ONLY use S3 URLs (removed local file fallbacks)
  - Added video URL detection and passing to podcast conversion
  - Made file cleanup mandatory instead of optional (removed `S3_DELETE_LOCAL_AFTER_UPLOAD` check)
  - Enhanced cleanup to include audio files and provide better logging
- **Purpose**: Ensure truly ephemeral storage - all URLs are S3-based, local files are immediately deleted

### 4. Improved ytdlpWrapper File Cleanup
- **File**: `src/lib/ytdlpWrapper.ts`
- **Changes**:
  - Removed conditional cleanup based on `deleteLocalAfterUpload` flag
  - Made file deletion automatic after successful S3 upload
  - Added better logging for cleanup operations
- **Purpose**: Ensure temp files are always cleaned up immediately after S3 upload

### 5. Fixed Table Name Consistency
- **File**: `src/server.ts`
- **Change**: Updated default table name from `'PodcastEpisodesStore'` to `'podcast-episodes'`
- **Purpose**: Match LocalStack setup and DynamoDB service defaults

### 6. Created Test Script
- **File**: `src/scripts/test-ephemeral-s3.ts`
- **Purpose**: Verify ephemeral file handling and S3-only URL storage
- **Added npm script**: `test:ephemeral-s3` and `test:ephemeral-s3:prod`

## Key Behavioral Changes

### Before
- Files were optionally deleted based on environment variable
- Podcast episodes could fallback to local file paths
- No video_url field in podcast episodes
- Inconsistent table naming

### After
- Files are ALWAYS deleted immediately after successful S3 upload
- Podcast episodes ONLY use S3 URLs (no local fallbacks)
- video_url field properly stored in podcast episodes
- Consistent table naming across all services
- Comprehensive cleanup of temp files during processing

## Testing
Run the test script to verify the implementation:
```bash
# With LocalStack
npm run test:ephemeral-s3

# With production AWS
npm run test:ephemeral-s3:prod
```

## Benefits
1. **True Ephemeral Storage**: Local files are cleaned up immediately, reducing disk usage
2. **S3-First Architecture**: All URLs in the database point to S3, enabling true cloud-native operation
3. **Complete Metadata**: Both audio and video URLs are stored for podcast episodes
4. **Consistent Behavior**: File cleanup happens automatically regardless of configuration
5. **Better Monitoring**: Enhanced logging for cleanup operations

## Environment Variables
The following environment variables control the behavior:
- `PODCAST_CONVERSION_ENABLED=true` - Enable podcast conversion
- S3 upload is automatically enabled if S3 credentials are configured
- Local file cleanup is now automatic (no longer requires `S3_DELETE_LOCAL_AFTER_UPLOAD`)

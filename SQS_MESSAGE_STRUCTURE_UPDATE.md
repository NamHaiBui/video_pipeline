# SQS Message Structure Update

## Overview

The SQS polling system has been updated to handle three distinct message types:

1. **Video Enrichment** - For existing episodes that need video downloaded
2. **New Entry** - For creating new episodes with comprehensive metadata
3. **Legacy Downloads** - For backward compatibility with existing systems

## Message Types

### 1. Video Enrichment
**Purpose**: Download video for an existing episode in the database.

**Structure**:
```json
{
  "id": "episode-12345",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

**Detection Logic**: `id` and `url` present, but no `videoId`
**Handler**: `downloadVideoForExistingEpisode()`

### 2. New Entry
**Purpose**: Create a new episode with comprehensive metadata.

**Structure**:
```json
{
  "videoId": "dQw4w9WgXcQ",
  "episodeTitle": "Never Gonna Give You Up",
  "channelName": "Rick Astley",
  "channelId": "UCuAXFkgsw1L7xaCfnd5JJOw",
  "originalUri": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "publishedDate": "2009-10-25T06:57:33Z",
  "contentType": "Video",
  "hostName": "Rick Astley",
  "hostDescription": "Official Rick Astley YouTube Channel",
  "languageCode": "en",
  "genre": "Music",
  "country": "UK",
  "websiteLink": "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
  "additionalData": {
    "youtubeVideoId": "dQw4w9WgXcQ",
    "youtubeChannelId": "UCuAXFkgsw1L7xaCfnd5JJOw",
    "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "triggeredManually": "2025-07-09T10:30:00.000Z"
  }
}
```

**Detection Logic**: `videoId`, `episodeTitle`, and `originalUri` present
**Handler**: `processDownload()` with new entry data

### 3. Legacy Downloads
**Purpose**: Backward compatibility with existing download messages.

**Structure**:
```json
{
  "jobId": "legacy-job-12345",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "channelId": "some-channel-id"
}
```

**Detection Logic**: Fallback when neither Video Enrichment nor New Entry patterns match
**Handler**: `processDownload()` with legacy data

## Code Changes

### Files Modified

1. **`src/sqsPoller.ts`**
   - Updated message type detection logic
   - Added handlers for Video Enrichment and New Entry message types
   - Improved error handling and validation
   - Updated logging to reflect new message types

2. **`src/types.ts`**
   - Updated `SQSJobMessage` interface to support all three message types
   - Made fields optional with clear documentation
   - Removed duplicate properties

### Key Features

- **Automatic Message Type Detection**: Messages are automatically classified based on their structure
- **Backward Compatibility**: Legacy messages continue to work without changes
- **Enhanced Logging**: Clear logging shows which message type is being processed
- **Robust Validation**: Each message type has specific validation rules
- **Job Tracking**: All message types use the same job tracking system for concurrency control

## Testing

A test script (`test_new_sqs_message_types.js`) has been created to verify:
- Message type detection accuracy
- Message validation logic
- Example messages for all three types

## Deployment Notes

- The changes are backward compatible
- Existing SQS messages will continue to work as "Legacy Downloads"
- No migration is required for existing data
- The system automatically detects and handles all message types

## Usage Examples

### Sending a Video Enrichment Message
```json
{
  "id": "existing-episode-id",
  "url": "https://youtube.com/watch?v=VIDEO_ID"
}
```

### Sending a New Entry Message
```json
{
  "videoId": "VIDEO_ID",
  "episodeTitle": "Episode Title",
  "originalUri": "https://youtube.com/watch?v=VIDEO_ID",
  "channelName": "Channel Name",
  "channelId": "CHANNEL_ID",
  "publishedDate": "2025-07-09T10:30:00Z",
  "contentType": "Video",
  "additionalData": {
    "triggeredManually": "2025-07-09T10:30:00.000Z"
  }
}
```

The system will automatically detect the message type and route it to the appropriate handler.

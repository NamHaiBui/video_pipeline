/**
 * Test script to demonstrate the new SQS message types
 * 
 * This script shows examples of the three supported message types:
 * 1. Video Enrichment - for existing episodes that need video downloaded
 * 2. New Entry - for creating new episodes with comprehensive metadata
 * 3. Legacy Downloads - for backward compatibility
 */

// Video Enrichment message example
const videoEnrichmentMessage = {
  "id": "episode-12345",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
};

// New Entry message example
const newEntryMessage = {
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
};

// Legacy Download message example (for backward compatibility)
const legacyDownloadMessage = {
  "jobId": "legacy-job-12345",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "channelId": "some-channel-id"
};

/**
 * Function to detect message type (similar to the logic in sqsPoller.ts)
 */
function detectMessageType(jobData) {
  const isVideoEnrichment = !!(jobData.id && jobData.url && !jobData.videoId);
  const isNewEntry = !!(jobData.videoId && jobData.episodeTitle && jobData.originalUri);
  
  if (isVideoEnrichment) {
    return 'Video Enrichment';
  } else if (isNewEntry) {
    return 'New Entry';
  } else {
    return 'Legacy Download';
  }
}

// Test the message type detection
console.log('Message Type Detection Test:');
console.log('==========================');
console.log(`Video Enrichment: ${detectMessageType(videoEnrichmentMessage)}`);
console.log(`New Entry: ${detectMessageType(newEntryMessage)}`);
console.log(`Legacy Download: ${detectMessageType(legacyDownloadMessage)}`);

console.log('\nMessage Examples:');
console.log('=================');

console.log('\n1. Video Enrichment Message:');
console.log(JSON.stringify(videoEnrichmentMessage, null, 2));

console.log('\n2. New Entry Message:');
console.log(JSON.stringify(newEntryMessage, null, 2));

console.log('\n3. Legacy Download Message:');
console.log(JSON.stringify(legacyDownloadMessage, null, 2));

console.log('\nMessage Validation:');
console.log('==================');

function validateMessage(jobData, type) {
  switch(type) {
    case 'Video Enrichment':
      return !!(jobData.id && jobData.url);
    case 'New Entry':
      return !!(jobData.videoId && jobData.episodeTitle && jobData.originalUri);
    case 'Legacy Download':
      return !!(jobData.url);
    default:
      return false;
  }
}

const messages = [
  { data: videoEnrichmentMessage, type: 'Video Enrichment' },
  { data: newEntryMessage, type: 'New Entry' },
  { data: legacyDownloadMessage, type: 'Legacy Download' }
];

messages.forEach(({ data, type }) => {
  const isValid = validateMessage(data, type);
  console.log(`${type}: ${isValid ? '✓ Valid' : '✗ Invalid'}`);
});

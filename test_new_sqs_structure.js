import { createRDSService } from './dist/lib/rdsService.js';

// Mock the new SQS message structure as described by the user
const newSqsMessage = {
    'videoId': 'test-video-123',
    'episodeTitle': 'Test Episode Title',
    'channelName': 'Test Channel',
    'channelId': 'test-channel-123',
    'originalUri': 'https://youtube.com/watch?v=test-video-123',
    'publishedDate': '2024-01-15T10:30:00Z',
    'contentType': 'Video',
    'hostName': 'Test Host',
    'hostDescription': 'A test host description',
    'genre': 'Technology',
    'country': 'USA',
    'websiteLink': 'https://www.youtube.com/channel/test-channel-123',
    'additionalData': {
        'youtubeVideoId': 'test-video-123',
        'youtubeChannelId': 'test-channel-123',
        'youtubeUrl': 'https://youtube.com/watch?v=test-video-123',
        'notificationReceived': new Date().toISOString()
    }
};

// Mock video metadata
const mockVideoMetadata = {
    title: 'Test Episode Title',
    uploader: 'Test Channel',
    id: 'test-video-123',
    duration: 3600, // 1 hour
    description: 'This is a test episode description',
    upload_date: '20240115',
    view_count: 10000,
    like_count: 500,
    age_limit: 0,
    webpage_url: 'https://youtube.com/watch?v=test-video-123',
    extractor: 'youtube',
    extractor_key: 'Youtube',
    thumbnail: 'https://i.ytimg.com/vi/test-video-123/maxresdefault.jpg',
    thumbnails: [],
    formats: []
};

async function testNewSqsStructure() {
    console.log('🧪 Testing new SQS message structure...');
    
    try {
        // Test SQS message extraction
        console.log('\n1. Testing SQS message extraction...');
        const rdsService = createRDSService();
        const extractedChannelInfo = rdsService.constructor.extractChannelInfoFromSQS(newSqsMessage);
        
        console.log('✅ Extracted channel info:', JSON.stringify(extractedChannelInfo, null, 2));
        
        // Test episode metadata processing
        console.log('\n2. Testing episode metadata processing...');
        const episodeInput = rdsService.processEpisodeMetadata(
            mockVideoMetadata,
            'https://s3.example.com/audio/test-audio.mp3',
            extractedChannelInfo
        );
        
        console.log('✅ Episode input created:', JSON.stringify({
            episodeId: episodeInput.episodeId,
            episodeTitle: episodeInput.episodeTitle,
            contentType: episodeInput.contentType,
            guests: episodeInput.guests,
            topics: episodeInput.topics,
            episodeImages: episodeInput.episodeImages,
            additionalData: episodeInput.additionalData
        }, null, 2));
        
        // Verify key requirements
        console.log('\n3. Verifying requirements...');
        
        // Content type should always be 'Video'
        if (episodeInput.contentType === 'Video') {
            console.log('✅ Content type is correctly set to "Video"');
        } else {
            console.log('❌ Content type should be "Video", got:', episodeInput.contentType);
        }
        
        // Guests should be empty (comes from enrichment)
        if (episodeInput.guests.length === 0) {
            console.log('✅ Guests array is empty (will be populated by enrichment)');
        } else {
            console.log('❌ Guests should be empty, got:', episodeInput.guests);
        }
        
        // Topics should be empty (comes from enrichment)
        if (episodeInput.topics.length === 0) {
            console.log('✅ Topics array is empty (will be populated by enrichment)');
        } else {
            console.log('❌ Topics should be empty, got:', episodeInput.topics);
        }
        
        // Episode images should be from video thumbnail
        if (episodeInput.episodeImages.includes(mockVideoMetadata.thumbnail)) {
            console.log('✅ Episode images include video thumbnail');
        } else {
            console.log('❌ Episode images should include video thumbnail, got:', episodeInput.episodeImages);
        }
        
        console.log('\n🎉 Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error);
    }
}

// Run the test
testNewSqsStructure();

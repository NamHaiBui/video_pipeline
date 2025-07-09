const dotenv = require('dotenv');
const { EnhancedGuestExtractor } = require('./dist/lib/guestEnrichmentService.js');

// Load environment variables
dotenv.config();

async function testEnhancedGuestExtraction() {
    console.log('🧪 Testing Enhanced Guest Extraction with Vertex AI...\n');
    
    // Test cases
    const testCases = [
        {
            name: "Single Guest Interview",
            episodeTitle: "Deep Dive with Elon Musk",
            episodeDescription: "In this episode, Joe Rogan sits down with Elon Musk to discuss SpaceX, Tesla, and the future of AI.",
            hostName: "Joe Rogan",
            podcastTitle: "The Joe Rogan Experience",
            expectedGuests: ["Elon Musk"]
        },
        {
            name: "Panel Discussion",
            episodeTitle: "Web3 Experts Panel",
            episodeDescription: "Sarah Chen moderates a discussion with Chris Dixon, Naval Ravikant, and Molly White about the future of Web3.",
            hostName: "Sarah Chen",
            podcastTitle: "Tech Talk",
            expectedGuests: ["Chris Dixon", "Naval Ravikant", "Molly White"]
        },
        {
            name: "Compilation Episode",
            episodeTitle: "Best of 2024",
            episodeDescription: "Highlights from our top 50 founder interviews this year.",
            hostName: "Mark Cuban",
            podcastTitle: "Startup Stories",
            expectedGuests: []
        },
        {
            name: "Solo Episode",
            episodeTitle: "My Thoughts on AI Safety",
            episodeDescription: "In this solo episode, I share my thoughts on the current state of AI safety research.",
            hostName: "Lex Fridman",
            podcastTitle: "Lex Fridman Podcast",
            expectedGuests: []
        }
    ];
    
    const extractor = new EnhancedGuestExtractor();
    
    console.log(`✅ Enhanced Guest Extractor initialized`);
    console.log(`🔧 Vertex AI available: ${extractor.isAvailable()}`);
    
    if (!extractor.isAvailable()) {
        console.log('⚠️ Vertex AI not available, testing pattern matching fallback...\n');
    } else {
        console.log('🎯 Testing Vertex AI guest extraction...\n');
    }
    
    for (const testCase of testCases) {
        console.log(`📋 Test: ${testCase.name}`);
        console.log(`   Episode: "${testCase.episodeTitle}"`);
        console.log(`   Host: ${testCase.hostName}`);
        console.log(`   Expected: [${testCase.expectedGuests.join(', ')}]`);
        
        try {
            const result = await extractor.extractGuests({
                episodeTitle: testCase.episodeTitle,
                episodeDescription: testCase.episodeDescription,
                hostName: testCase.hostName,
                podcastTitle: testCase.podcastTitle
            });
            
            console.log(`   📊 Result:`);
            console.log(`      Guests: [${result.guest_names_display.join(', ')}]`);
            console.log(`      Method: ${result.method}`);
            console.log(`      Confidence: ${result.confidence}`);
            console.log(`      Summary: ${result.summary}`);
            console.log(`      Is Compilation: ${result.is_compilation}`);
            console.log(`      Multiple Guests: ${result.has_multiple_guests}`);
            
            // Simple validation
            const expectedCount = testCase.expectedGuests.length;
            const actualCount = result.guest_names_display.length;
            const status = expectedCount === actualCount ? '✅' : '⚠️';
            console.log(`   ${status} Guest count: expected ${expectedCount}, got ${actualCount}`);
            
        } catch (error) {
            console.log(`   ❌ Error: ${error.message}`);
        }
        
        console.log('');
    }
}

// Run the test
testEnhancedGuestExtraction().catch(console.error);

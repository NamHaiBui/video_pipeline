/**
 * Test script for Guest Enrichment functionality
 */

import { GuestEnrichmentService } from './dist/lib/guestEnrichmentService.js';

// Test guest name extraction
console.log('🧪 Testing Guest Name Extraction');
console.log('================================');

const testCases = [
  {
    title: "Building the Future of AI with Elon Musk and Sam Altman",
    description: "In this episode, we sit down with Elon Musk, CEO of Tesla and SpaceX, and Sam Altman, CEO of OpenAI, to discuss the future of artificial intelligence.",
    expected: ["Elon Musk", "Sam Altman"]
  },
  {
    title: "Tech Talk featuring Mark Zuckerberg",
    description: "Join us for an exclusive interview with Mark Zuckerberg as we explore the metaverse and social media trends.",
    expected: ["Mark Zuckerberg"]
  },
  {
    title: "Startup Stories with Reid Hoffman",
    description: "Reid Hoffman shares insights about building successful companies and the future of entrepreneurship.",
    expected: ["Reid Hoffman"]
  }
];

testCases.forEach((testCase, index) => {
  console.log(`\nTest Case ${index + 1}:`);
  console.log(`Title: "${testCase.title}"`);
  console.log(`Description: "${testCase.description.substring(0, 80)}..."`);
  
  const extractedGuests = GuestEnrichmentService.extractGuestNamesFromMetadata(
    testCase.title,
    testCase.description
  );
  
  console.log(`Expected: ${JSON.stringify(testCase.expected)}`);
  console.log(`Extracted: ${JSON.stringify(extractedGuests)}`);
  
  const match = JSON.stringify(extractedGuests.sort()) === JSON.stringify(testCase.expected.sort());
  console.log(`Result: ${match ? '✅ PASS' : '❌ FAIL'}`);
});

console.log('\n🎯 Guest Enrichment Service Status:');
console.log('===================================');

const guestService = new GuestEnrichmentService();
console.log(`Service Available: ${guestService.isAvailable() ? '✅ YES' : '❌ NO (PPLX_API_KEY not set)'}`);

if (!guestService.isAvailable()) {
  console.log('\n💡 To enable guest enrichment:');
  console.log('1. Get a Perplexity AI API key from https://www.perplexity.ai/');
  console.log('2. Add it to your .env file: PPLX_API_KEY=your_key_here');
  console.log('3. Restart the application');
}

console.log('\n✅ Guest enrichment tests completed!');

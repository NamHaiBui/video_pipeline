import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

console.log('Environment Variables Check:');
console.log('PERPLEXITY_KEY:', process.env.PERPLEXITY_KEY ? '✅ Set' : '❌ Not set');
console.log('OPENAI_KEY:', process.env.OPENAI_KEY ? '✅ Set' : '❌ Not set');
console.log('GEMINI_KEY:', process.env.GEMINI_KEY ? '✅ Set' : '❌ Not set');

console.log('\nFirst few characters of keys:');
if (process.env.PERPLEXITY_KEY) {
  console.log('PERPLEXITY_KEY:', process.env.PERPLEXITY_KEY.substring(0, 10) + '...');
}
if (process.env.OPENAI_KEY) {
  console.log('OPENAI_KEY:', process.env.OPENAI_KEY.substring(0, 10) + '...');
}
if (process.env.GEMINI_KEY) {
  console.log('GEMINI_KEY:', process.env.GEMINI_KEY.substring(0, 10) + '...');
}

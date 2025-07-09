import dotenv from 'dotenv';
import OpenAI from 'openai';
import { logger } from './logger.js';

// Load environment variables
dotenv.config();

// --- Configuration ---
const PPLX_API_KEY = process.env.PERPLEXITY_KEY;
const BASE_URL = "https://api.perplexity.ai";
const MODEL_ID = "sonar";
const MAX_RETRIES = 3;

// --- Guest Extraction Utilities ---
/**
 * Extract guest names from episode metadata using pattern matching
 * This is a simplified version of the guest extraction logic
 */
export function extractGuestNamesFromMetadata(
    episodeTitle: string,
    episodeDescription?: string,
    personalities?: string[]
): string[] {
    const guests: string[] = [];
    const text = `${episodeTitle} ${episodeDescription || ''}`.toLowerCase();
    
    // Common patterns for guest identification
    const guestPatterns = [
        /(?:with|featuring|ft\.?|interview with|talk with|conversation with)\s+([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
        /guest:?\s+([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
        /([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:joins|discusses|shares|talks about)/gi
    ];
    
    for (const pattern of guestPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const name = match[1].trim();
            if (name.length > 3 && !guests.includes(name)) {
                guests.push(name);
            }
        }
    }
    
    // If personalities are provided, filter them (excluding likely hosts)
    if (personalities && personalities.length > 0) {
        const hostKeywords = ['host', 'podcast', 'show', 'radio'];
        personalities.forEach(person => {
            const personName = person.trim();
            if (personName.length > 2 && 
                !hostKeywords.some(keyword => personName.toLowerCase().includes(keyword)) &&
                !guests.includes(personName)) {
                guests.push(personName);
            }
        });
    }
    
    return guests.slice(0, 5); // Limit to 5 guests max
}

/**
 * Enhanced guest extraction with confidence scoring
 */
export interface GuestExtractionResult {
    guest_names: string[];
    confidence: "high" | "medium" | "low" | "none";
    summary: string;
    is_compilation: boolean;
    has_multiple_guests: boolean;
}

export function extractGuestsWithConfidence(
    episodeTitle: string,
    episodeDescription?: string,
    hostName?: string,
    personalities?: string[]
): GuestExtractionResult {
    const extractedGuests = extractGuestNamesFromMetadata(episodeTitle, episodeDescription, personalities);
    
    // Determine if it's a compilation episode
    const compilationKeywords = ['best of', 'compilation', 'highlights', 'retrospective', 'year in review'];
    const isCompilation = compilationKeywords.some(keyword => 
        episodeTitle.toLowerCase().includes(keyword) || 
        (episodeDescription && episodeDescription.toLowerCase().includes(keyword))
    );
    
    // Filter out host name if provided
    const filteredGuests = extractedGuests.filter(guest => 
        !hostName || guest.toLowerCase() !== hostName.toLowerCase()
    );
    
    // Determine confidence based on extraction quality
    let confidence: "high" | "medium" | "low" | "none" = "none";
    if (filteredGuests.length > 0) {
        if (episodeTitle.toLowerCase().includes('interview') || 
            episodeTitle.toLowerCase().includes('with ') ||
            (episodeDescription && episodeDescription.toLowerCase().includes('interview'))) {
            confidence = "high";
        } else if (filteredGuests.length > 1) {
            confidence = "medium";
        } else {
            confidence = "low";
        }
    }
    
    return {
        guest_names: filteredGuests,
        confidence,
        summary: `Extracted ${filteredGuests.length} guest(s) from episode metadata`,
        is_compilation: isCompilation,
        has_multiple_guests: filteredGuests.length > 1
    };
}

// --- Type Definitions ---
const TOPICS_SCHEMA = {
    type: "object",
    properties: {
        topics: {
            type: "array",
            items: { type: "string" },
            description: "Array of 3-8 main topics/themes discussed in the episode, using specific and descriptive terms"
        },
        confidence: { 
            type: "string", 
            enum: ["high", "medium", "low"], 
            description: "Confidence level in the accuracy and completeness of the topics identified" 
        }
    },
    required: ["topics", "confidence"]
};

export interface TopicEnrichmentInput {
    episodeTitle: string;
    episodeDescription?: string;
    channelName: string;
    hostName?: string;
    guests?: string[];
}

export interface TopicEnrichmentResult {
    topics: string[];
    confidence: "high" | "medium" | "low";
    status: 'success' | 'error';
    errorMessage?: string;
}

/**
 * Topic Enrichment Service using Perplexity AI
 * Identifies and extracts main topics/themes from podcast episodes
 */
export class TopicEnrichmentService {
    private pplxClient: OpenAI | null = null;

    constructor() {
        this.initializeClient();
    }

    /**
     * Initialize Perplexity AI client
     */
    private initializeClient(): void {
        if (!PPLX_API_KEY || PPLX_API_KEY === "YOUR_PERPLEXITY_KEY_HERE") {
            logger.warn("PERPLEXITY_KEY is not set. Topic enrichment will be disabled.");
            return;
        }

        try {
            this.pplxClient = new OpenAI({
                apiKey: PPLX_API_KEY,
                baseURL: BASE_URL,
            });
            logger.info("✅ Perplexity client initialized for topic enrichment");
        } catch (error: any) {
            logger.error("❌ Failed to initialize Perplexity client", error);
        }
    }

    /**
     * Check if topic enrichment is available
     */
    isAvailable(): boolean {
        return this.pplxClient !== null;
    }

    /**
     * Extract main topics from episode information
     */
    async enrichTopics(input: TopicEnrichmentInput): Promise<TopicEnrichmentResult> {
        const { episodeTitle, episodeDescription, channelName, hostName, guests } = input;

        if (!this.pplxClient) {
            return {
                topics: [],
                confidence: "low",
                status: "error",
                errorMessage: "Perplexity client not initialized"
            };
        }

        // Build context string from available information
        const guestsText = guests && guests.length > 0 ? ` with guests: ${guests.join(', ')}` : '';
        const hostText = hostName ? ` hosted by ${hostName}` : '';
        const descriptionText = episodeDescription ? `\nDescription: ${episodeDescription}` : '';
        
        const contextInfo = `Podcast: ${channelName}${hostText}
Episode: ${episodeTitle}${guestsText}${descriptionText}`;

        const systemMsg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: "system",
            content: "You are an expert at analyzing podcast content and identifying key topics and themes. Respond only with valid JSON matching the provided schema."
        };

        const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: "user",
            content: `Analyze this podcast episode and identify 3-8 main topics or themes that would likely be discussed. Base your analysis on the episode title, description, host, guests, and podcast context.

${contextInfo}

Provide specific, descriptive topic names that would be useful for categorization and search. Focus on:
- Subject areas, industries, or fields of expertise
- Key concepts, technologies, or methodologies
- Themes like entrepreneurship, innovation, personal development, etc.
- Specific tools, companies, or trends mentioned

Confidence levels:
- 'high': Strong contextual clues from title, description, and known guest expertise
- 'medium': Good inference from available information
- 'low': Limited information, mostly generic topics

IMPORTANT: Respond with ONLY a JSON object in this exact format:
{
  "topics": ["topic1", "topic2", "topic3"],
  "confidence": "high"
}

Do not include any explanation or additional text outside the JSON object.`
        };

        let lastKnownError = "Unknown error";
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                logger.debug(`Enriching topics for episode: ${episodeTitle} (attempt ${attempt}/${MAX_RETRIES})`);

                const apiResponse = await this.pplxClient.chat.completions.create({
                    model: MODEL_ID,
                    messages: [systemMsg, userMsg],
                    temperature: 0.3, // Slightly higher temperature for more creative topic identification
                });

                const content = apiResponse.choices[0].message.content;
                if (!content) {
                    throw new Error("API returned empty content.");
                }
                
                const data = JSON.parse(content) as { topics: string[]; confidence: "high" | "medium" | "low" };

                // Validate the response
                if (!Array.isArray(data.topics) || data.topics.length === 0) {
                    throw new Error("Invalid topics array returned from API");
                }

                // Clean and filter topics
                const cleanedTopics = data.topics
                    .filter(topic => topic && typeof topic === 'string' && topic.trim().length > 0)
                    .map(topic => topic.trim())
                    .slice(0, 8); // Limit to maximum 8 topics

                if (cleanedTopics.length === 0) {
                    throw new Error("No valid topics extracted from API response");
                }

                logger.info(`✅ Successfully enriched topics for episode: ${episodeTitle} (${cleanedTopics.length} topics)`);
                return {
                    topics: cleanedTopics,
                    confidence: data.confidence,
                    status: "success"
                };

            } catch (error: any) {
                lastKnownError = error.message || String(error);
                
                if (error.status === 429) {
                    lastKnownError = `RateLimitError: ${error.message}`;
                } else if (error.status && error.status >= 400) {
                    if (error.status >= 500 || error.status === 429) {
                        lastKnownError = `APIStatusError ${error.status}`;
                    } else {
                        // Non-retriable API error
                        logger.error(`❌ Non-retriable API error for topic enrichment ${episodeTitle}:`, error);
                        return {
                            topics: [],
                            confidence: "low",
                            status: "error",
                            errorMessage: `APIStatusError ${error.status}: ${error.message}`
                        };
                    }
                }

                logger.warn(`⚠️ Topic enrichment attempt ${attempt}/${MAX_RETRIES} failed for ${episodeTitle}: ${lastKnownError}`);
                
                if (attempt < MAX_RETRIES) {
                    const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        logger.error(`❌ All topic enrichment attempts failed for ${episodeTitle}: ${lastKnownError}`);
        return {
            topics: [],
            confidence: "low",
            status: "error",
            errorMessage: lastKnownError
        };
    }

    /**
     * Batch process topics for multiple episodes
     */
    async batchEnrichTopics(inputs: TopicEnrichmentInput[]): Promise<TopicEnrichmentResult[]> {
        logger.info(`🔍 Starting batch topic enrichment for ${inputs.length} episodes`);
        
        const results: TopicEnrichmentResult[] = [];
        
        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            logger.debug(`Processing episode ${i + 1}/${inputs.length}: ${input.episodeTitle}`);
            
            try {
                const result = await this.enrichTopics(input);
                results.push(result);
                
                // Add delay between batch operations to avoid overwhelming the API
                if (i < inputs.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error: any) {
                logger.error(`❌ Batch topic enrichment error for episode ${input.episodeTitle}:`, error);
                results.push({
                    topics: [],
                    confidence: "low",
                    status: "error",
                    errorMessage: error.message || String(error)
                });
            }
        }

        const successful = results.filter(r => r.status === 'success').length;
        const failed = results.length - successful;
        
        logger.info(`✅ Batch topic enrichment completed: ${successful} successful, ${failed} failed`);
        return results;
    }

    /**
     * Generate fallback topics based on episode information when LLM is not available
     */
    generateFallbackTopics(input: TopicEnrichmentInput): string[] {
        const fallbackTopics: string[] = [];
        
        // Extract potential topics from episode title
        const title = input.episodeTitle.toLowerCase();
        
        // Basic keyword-based topic extraction
        const topicKeywords = {
            'entrepreneurship': ['startup', 'entrepreneur', 'business', 'founder', 'company'],
            'technology': ['tech', 'ai', 'software', 'digital', 'innovation', 'data'],
            'finance': ['money', 'investment', 'financial', 'crypto', 'trading', 'wealth'],
            'health': ['health', 'wellness', 'fitness', 'medical', 'nutrition'],
            'education': ['learning', 'education', 'teaching', 'academic', 'university'],
            'leadership': ['leadership', 'management', 'ceo', 'executive', 'strategy'],
            'personal development': ['growth', 'mindset', 'success', 'motivation', 'habits'],
            'marketing': ['marketing', 'brand', 'social media', 'advertising', 'growth'],
            'science': ['research', 'science', 'discovery', 'study', 'experiment']
        };

        for (const [topic, keywords] of Object.entries(topicKeywords)) {
            if (keywords.some(keyword => title.includes(keyword))) {
                fallbackTopics.push(topic);
            }
        }

        // Add guest-based topics if available
        if (input.guests && input.guests.length > 0) {
            fallbackTopics.push('interviews');
        }

        // Add channel-based topics
        const channelName = input.channelName.toLowerCase();
        if (channelName.includes('business') || channelName.includes('entrepreneur')) {
            fallbackTopics.push('business strategy');
        }
        if (channelName.includes('tech') || channelName.includes('innovation')) {
            fallbackTopics.push('technology trends');
        }

        // Ensure we have at least some topics
        if (fallbackTopics.length === 0) {
            fallbackTopics.push('discussion', 'insights');
        }

        return Array.from(new Set(fallbackTopics)).slice(0, 5); // Remove duplicates and limit
    }
}

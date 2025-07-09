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

// OpenAI Configuration for enhanced extraction
const OPENAI_API_KEY = process.env.OPENAI_KEY;

// --- Enhanced Guest Extraction Types ---
export type ConfidenceLevel = "high" | "medium" | "low" | "none";

export interface EnhancedGuestExtraction {
    guest_names: string[];
    confidence: ConfidenceLevel;
    summary: string;
    is_compilation: boolean;
    has_multiple_guests: boolean;
}

export interface GuestExtractionInput {
    episodeTitle: string;
    episodeDescription?: string;
    hostName?: string;
    podcastTitle: string;
    personalities?: string[];
}

export interface GuestExtractionResult {
    episode_id: string;
    podcast_title: string;
    episode_title: string;
    host_name: string;
    guest_names_display: string[];
    guest_count: number;
    confidence: ConfidenceLevel;
    summary: string;
    is_compilation: boolean;
    has_multiple_guests: boolean;
    extraction_timestamp: string;
    method: 'openai' | 'pattern_matching';
}

// --- Type Definitions ---
const PERSON_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "The full name of the person, exactly as provided in the input." },
        description: { type: "string", description: "A concise, factual, and neutral description of the person in context of their podcast appearance, 1-3 sentences." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence level in the accuracy and completeness of the description provided." }
    },
    required: ["name", "description", "confidence"]
};

export interface Person {
    name: string;
    description: string;
    confidence: "high" | "medium" | "low";
}

export interface GuestEnrichmentInput {
    name: string;
    podcastTitle: string;
    episodeTitle: string;
}

export interface GuestEnrichmentResult {
    name: string;
    description: string;
    confidence: "high" | "medium" | "low";
    status: 'success' | 'error';
    errorMessage?: string;
}

/**
 * Guest Enrichment Service using Perplexity AI
 * Generates biographical information for podcast guests
 */
export class GuestEnrichmentService {
    private pplxClient: OpenAI | null = null;

    constructor() {
        this.initializeClient();
    }

    /**
     * Initialize Perplexity AI client
     */
    private initializeClient(): void {
        if (!PPLX_API_KEY || PPLX_API_KEY === "YOUR_PERPLEXITY_KEY_HERE") {
            logger.warn("PERPLEXITY_KEY is not set. Guest enrichment will be disabled.");
            return;
        }

        try {
            this.pplxClient = new OpenAI({
                apiKey: PPLX_API_KEY,
                baseURL: BASE_URL,
            });
            logger.info("✅ Perplexity client initialized for guest enrichment");
        } catch (error: any) {
            logger.error("❌ Failed to initialize Perplexity client", error);
        }
    }

    /**
     * Check if guest enrichment is available
     */
    isAvailable(): boolean {
        return this.pplxClient !== null;
    }

    /**
     * Fetch biographical information for a single guest
     */
    async enrichGuest(input: GuestEnrichmentInput): Promise<GuestEnrichmentResult> {
        const { name, podcastTitle, episodeTitle } = input;

        if (!this.pplxClient) {
            return {
                name,
                description: "Guest enrichment service not available",
                confidence: "low",
                status: "error",
                errorMessage: "Perplexity client not initialized"
            };
        }

        const systemMsg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: "system",
            content: "Respond only with valid JSON matching the provided schema.",
        };

        const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: "user",
            content: `Find biographical information for ${name} who appeared on the podcast '${podcastTitle}' in the episode titled '${episodeTitle}'. Write a factual 1-3 sentence professional biography including their role, notable work, and why they would be relevant to this podcast episode. Include confidence level: 'high' if multiple reliable sources found with specific details, 'medium' if basic professional information available, 'low' if minimal or no specific information found. If no reliable information exists, state 'No specific public information available for this individual.'

IMPORTANT: Respond with ONLY a JSON object in this exact format:
{
  "name": "${name}",
  "description": "professional biography here",
  "confidence": "high"
}

Do not include any explanation or additional text outside the JSON object.`
        };

        let lastKnownError = "Unknown error";
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                logger.debug(`Enriching guest: ${name} (attempt ${attempt}/${MAX_RETRIES})`);

                const apiResponse = await this.pplxClient.chat.completions.create({
                    model: MODEL_ID,
                    messages: [systemMsg, userMsg],
                    temperature: 0.2,
                });

                const content = apiResponse.choices[0].message.content;
                if (!content) {
                    throw new Error("API returned empty content.");
                }
                
                const data = JSON.parse(content) as Person;

                logger.info(`✅ Successfully enriched guest: ${name}`);
                return {
                    name: data.name,
                    description: data.description,
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
                        logger.error(`❌ Non-retriable API error for guest ${name}:`, error);
                        return {
                            name,
                            description: `APIStatusError ${error.status}`,
                            confidence: "low",
                            status: "error",
                            errorMessage: `APIStatusError ${error.status}: ${error.message}`
                        };
                    }
                } else if (error instanceof SyntaxError) {
                    lastKnownError = `JSONParseError: Could not parse API response`;
                }

                if (attempt < MAX_RETRIES) {
                    const waitTime = (2 ** (attempt - 1)) * 1000 + Math.random() * 500;
                    logger.debug(`Retrying guest enrichment for '${name}' (attempt ${attempt}/${MAX_RETRIES}). Waiting ${Math.round(waitTime/1000)}s...`);
                    await new Promise(res => setTimeout(res, waitTime));
                }
            }
        }
        
        logger.warn(`❌ Max retries reached for guest: ${name}. Last error: ${lastKnownError}`);
        return {
            name,
            description: `Failed after ${MAX_RETRIES} attempts. Last error: ${lastKnownError}`,
            confidence: "low",
            status: "error",
            errorMessage: lastKnownError
        };
    }

    /**
     * Enrich multiple guests in batch
     */
    async enrichGuests(inputs: GuestEnrichmentInput[]): Promise<GuestEnrichmentResult[]> {
        if (!this.isAvailable()) {
            logger.warn("Guest enrichment service not available, returning empty descriptions");
            return inputs.map(input => ({
                name: input.name,
                description: "Guest enrichment service not available",
                confidence: "low" as const,
                status: "error" as const,
                errorMessage: "Service not available"
            }));
        }

        logger.info(`🔍 Starting guest enrichment for ${inputs.length} guests`);

        const results: GuestEnrichmentResult[] = [];
        
        // Process guests sequentially to avoid rate limiting
        for (const input of inputs) {
            try {
                const result = await this.enrichGuest(input);
                results.push(result);
                
                // Add small delay between requests to be respectful to API
                await new Promise(res => setTimeout(res, 500));
            } catch (error: any) {
                logger.error(`❌ Error enriching guest ${input.name}:`, error);
                results.push({
                    name: input.name,
                    description: "Error occurred during enrichment",
                    confidence: "low",
                    status: "error",
                    errorMessage: error.message
                });
            }
        }

        const successCount = results.filter(r => r.status === 'success').length;
        logger.info(`✅ Guest enrichment completed: ${successCount}/${inputs.length} successful`);

        return results;
    }

    /**
     * Extract guest names from video metadata or episode description
     * Enhanced version that uses Vertex AI when available, falls back to pattern matching
     */
    static async extractGuestNamesFromMetadata(
        title: string, 
        description: string, 
        hostName?: string,
        podcastTitle?: string
    ): Promise<string[]> {
        const enhancedExtractor = new EnhancedGuestExtractor();
        
        if (enhancedExtractor.isAvailable()) {
            try {
                const result = await enhancedExtractor.extractGuests({
                    episodeTitle: title,
                    episodeDescription: description,
                    hostName,
                    podcastTitle: podcastTitle || 'Unknown Podcast'
                });
                return result.guest_names_display;
            } catch (error: any) {
                logger.warn(`Enhanced guest extraction failed, using pattern matching: ${error.message}`);
            }
        }

        // Fallback to original pattern matching
        const guestIndicators = [
            /with\s+([A-Z][a-z]+ [A-Z][a-z]+)/gi,
            /guest[s]?:\s*([A-Z][a-z]+ [A-Z][a-z]+)/gi,
            /featuring\s+([A-Z][a-z]+ [A-Z][a-z]+)/gi,
            /interview[s]?\s+([A-Z][a-z]+ [A-Z][a-z]+)/gi,
        ];

        const extractedNames: Set<string> = new Set();

        // Check title and description for guest names
        const textToAnalyze = `${title} ${description}`;
        
        guestIndicators.forEach(regex => {
            let match;
            while ((match = regex.exec(textToAnalyze)) !== null) {
                const name = match[1].trim();
                if (name && name.length > 3) { // Basic validation
                    extractedNames.add(name);
                }
            }
        });

        return Array.from(extractedNames);
    }
}

/**
 * Create guest enrichment service instance
 */
export function createGuestEnrichmentService(): GuestEnrichmentService {
    return new GuestEnrichmentService();
}

/**
 * Enhanced Guest Extractor using OpenAI
 * This provides more accurate guest extraction than pattern matching
 */
export class EnhancedGuestExtractor {
    private openaiClient: OpenAI | null = null;

    constructor() {
        this.initializeOpenAI();
    }

    private initializeOpenAI(): void {
        if (!OPENAI_API_KEY || OPENAI_API_KEY === "YOUR_OPENAI_KEY_HERE") {
            logger.warn("OPENAI_KEY not set. Enhanced guest extraction will be disabled.");
            return;
        }

        try {
            this.openaiClient = new OpenAI({
                apiKey: OPENAI_API_KEY,
            });
            logger.info("✅ OpenAI initialized for enhanced guest extraction");
        } catch (error: any) {
            logger.error("❌ Failed to initialize OpenAI", error);
        }
    }

    isAvailable(): boolean {
        return this.openaiClient !== null;
    }

    private createExtractionPrompt(input: GuestExtractionInput): string {
        const { episodeTitle, episodeDescription, hostName, podcastTitle, personalities } = input;
        const personalitiesStr = personalities && personalities.length > 0 ? personalities.join(', ') : 'none';

        return `Extract guest names from this podcast episode.

EXAMPLES:
Episode: "interview-with-elon-musk", Host: Joe Rogan, Description: Joe sits down with Elon Musk to discuss SpaceX, Personalities: joe rogan, elon musk -> Result: ["Elon Musk"]
Episode: "best-of-2024", Host: Mark Cuban, Description: Highlights from 50+ founder interviews this year, Personalities: mark cuban -> Result: []
Episode: "panel-web3-experts", Host: Sarah Chen, Description: Sarah moderates discussion with Chris Dixon, Naval Ravikant, and Molly White, Personalities: sarah chen, chris dixon, naval ravikant, molly white -> Result: ["Chris Dixon", "Naval Ravikant", "Molly White"]

CURRENT EPISODE:
Podcast: "${podcastTitle}"
Episode: "${episodeTitle}"
Host: ${hostName || 'unknown'}
Description: ${episodeDescription || 'none'}
Personalities: ${personalitiesStr}

RULES:
1. Extract people interviewed/featured (NOT the host).
2. For panels: list ALL participants except host/moderator.
3. Empty list for: compilations, retrospectives, solo episodes.
4. Exclude people only mentioned but not present.
5. Return proper case names (e.g., "Aaron Siri", "Bobby Kennedy Jr.").

Respond with JSON containing:
- guest_names: array of guest names
- confidence: "high", "medium", "low", or "none"
- summary: brief explanation of extraction
- is_compilation: boolean if this is a compilation episode
- has_multiple_guests: boolean if more than one guest`;
    }

    async extractGuests(input: GuestExtractionInput): Promise<GuestExtractionResult> {
        const episodeId = `${input.podcastTitle}::${input.episodeTitle}`;

        if (!this.openaiClient) {
            // Fallback to pattern matching
            return this.extractGuestsWithPatternMatching(input);
        }

        try {
            const systemMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                role: "system",
                content: "You are an expert at extracting guest names from podcast episode metadata. Respond with valid JSON only."
            };

            const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
                role: "user",
                content: this.createExtractionPrompt(input)
            };

            const response = await this.openaiClient.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [systemMsg, userMsg],
                temperature: 0.1,
                response_format: { type: "json_object" }
            });

            const responseText = response.choices[0].message.content;
            if (!responseText) {
                throw new Error("OpenAI returned empty response.");
            }

            const extraction = JSON.parse(responseText) as EnhancedGuestExtraction;

            const finalResult: GuestExtractionResult = {
                episode_id: episodeId,
                podcast_title: input.podcastTitle,
                episode_title: input.episodeTitle,
                host_name: input.hostName || 'unknown',
                guest_names_display: extraction.guest_names,
                guest_count: extraction.guest_names.length,
                confidence: extraction.confidence,
                summary: extraction.summary,
                is_compilation: extraction.is_compilation,
                has_multiple_guests: extraction.has_multiple_guests,
                extraction_timestamp: new Date().toISOString(),
                method: 'openai'
            };

            logger.info(`✅ Enhanced guest extraction completed for: ${episodeId} (${extraction.guest_names.length} guests, confidence: ${extraction.confidence})`);
            return finalResult;

        } catch (error: any) {
            logger.warn(`⚠️ OpenAI extraction failed for ${episodeId}, falling back to pattern matching: ${error.message}`);
            return this.extractGuestsWithPatternMatching(input);
        }
    }

    private extractGuestsWithPatternMatching(input: GuestExtractionInput): GuestExtractionResult {
        const episodeId = `${input.podcastTitle}::${input.episodeTitle}`;
        const text = `${input.episodeTitle} ${input.episodeDescription || ''}`.toLowerCase();
        
        // Enhanced pattern matching
        const guestPatterns = [
            /(?:with|featuring|ft\.?|interview with|talk with|conversation with)\s+([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
            /guest:?\s+([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
            /([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:joins|discusses|shares|talks about)/gi
        ];
        
        const guests: string[] = [];
        
        for (const pattern of guestPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const name = match[1].trim();
                if (name.length > 3 && !guests.includes(name)) {
                    guests.push(name);
                }
            }
        }
        
        // Filter out host name if provided
        const filteredGuests = guests.filter(guest => 
            !input.hostName || guest.toLowerCase() !== input.hostName.toLowerCase()
        );
        
        // Check for compilation keywords
        const compilationKeywords = ['best of', 'compilation', 'highlights', 'retrospective', 'year in review'];
        const isCompilation = compilationKeywords.some(keyword => 
            text.includes(keyword)
        );
        
        // Determine confidence
        let confidence: ConfidenceLevel = "none";
        if (filteredGuests.length > 0) {
            if (text.includes('interview') || text.includes('with ')) {
                confidence = "medium";
            } else {
                confidence = "low";
            }
        }
        
        return {
            episode_id: episodeId,
            podcast_title: input.podcastTitle,
            episode_title: input.episodeTitle,
            host_name: input.hostName || 'unknown',
            guest_names_display: filteredGuests,
            guest_count: filteredGuests.length,
            confidence,
            summary: `Pattern matching extracted ${filteredGuests.length} guest(s)`,
            is_compilation: isCompilation,
            has_multiple_guests: filteredGuests.length > 1,
            extraction_timestamp: new Date().toISOString(),
            method: 'pattern_matching'
        };
    }

    async extractGuestsWithRetry(input: GuestExtractionInput, maxRetries: number = 3): Promise<GuestExtractionResult> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.extractGuests(input);
                return result;
            } catch (error: any) {
                if (attempt < maxRetries) {
                    logger.warn(`⚠️ Guest extraction attempt ${attempt}/${maxRetries} failed, retrying: ${error.message}`);
                    await new Promise(res => setTimeout(res, 2 ** attempt * 1000));
                } else {
                    logger.error(`❌ All guest extraction attempts failed for ${input.episodeTitle}: ${error.message}`);
                    // Return fallback result
                    return this.extractGuestsWithPatternMatching(input);
                }
            }
        }
        
        // This should never be reached due to the fallback above, but TypeScript requires it
        return this.extractGuestsWithPatternMatching(input);
    }
}

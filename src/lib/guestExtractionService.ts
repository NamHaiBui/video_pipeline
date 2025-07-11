import axios from 'axios';
import { OpenAI } from 'openai';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';
import { RDSService } from './rdsService.js';

// ========================= TypeScript Interfaces (Data Models) =========================

export interface PodcastExtraction {
    podcast_title: string;
    episode_title: string;
    guest_names: string[];
    description: string;
    topics: string[];
}

export interface GuestBio {
    name: string;
    description: string;
    confidence: "high" | "medium" | "low";
}

export interface ImageVerification {
    is_correct_person: boolean;
    is_good_profile_pic: boolean;
    confidence: "high" | "medium" | "low";
    reasoning: string;
}

export interface ImageInfo {
    url: string | null;
    source: string | null;
    method: 'google_images' | 'wikipedia' | 'none';
    status: 'found' | 'not_found';
    message?: string;
    metadata?: { title: string; context: string };
}

export interface GuestExtractionConfig {
    // API Keys
    geminiApiKey?: string;
    perplexityApiKey?: string;
    searchApiKey?: string;
    searchEngineId?: string;
    
    // API Models & URLs
    geminiBaseUrl: string;
    geminiModel: string;
    geminiFlashModel: string;
    perplexityBaseUrl: string;
    perplexityModel: string;
    googleSearchApiUrl: string;

    // AWS S3
    s3Bucket: string;
    s3Prefix: string;
    awsRegion: string;
    
    // Other
    maxRetries: number;
}

export interface GuestExtractionResult {
    podcast_title: string;
    episode_title: string;
    guest_names: string[];
    description: string;
    topics: string[];
    guest_details: Record<string, any>;
}

// ========================= Guest Extraction Service =========================

export class GuestExtractionService {
    private config: GuestExtractionConfig;
    private s3Client: S3Client;
    private perplexityClient?: OpenAI;
    private geminiClient?: OpenAI;
    private rdsService?: RDSService;

    constructor(config: Partial<GuestExtractionConfig>, rdsService?: RDSService) {
        this.config = {
            geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
            geminiModel: "gemini-1.5-pro",
            geminiFlashModel: "gemini-2.5-flash",
            perplexityBaseUrl: "https://api.perplexity.ai",
            perplexityModel: "sonar",
            googleSearchApiUrl: "https://www.googleapis.com/customsearch/v1",
            s3Bucket: process.env.S3_BUCKET_NAME || "spice-user-content-assets",
            s3Prefix: "guest-images/",
            awsRegion: process.env.AWS_REGION || "us-east-1",
            maxRetries: 3,
            ...config
        };

        this.s3Client = new S3Client({ region: this.config.awsRegion });
        this.rdsService = rdsService;

        // Initialize API clients if keys are available
        if (this.config.perplexityApiKey) {
            this.perplexityClient = new OpenAI({
                apiKey: this.config.perplexityApiKey,
                baseURL: this.config.perplexityBaseUrl,
            });
        }

        if (this.config.geminiApiKey) {
            this.geminiClient = new OpenAI({
                apiKey: this.config.geminiApiKey,
                baseURL: this.config.geminiBaseUrl,
            });
        }
    }

    // ========================= Database Functions =========================

    private normalizeName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9\s-()]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async checkExistingGuests(guestNames: string[]): Promise<{ existsMap: Record<string, boolean>; guestIdMap: Record<string, string> }> {
        logger.info("Checking for existing guests in database...");
        const existsMap: Record<string, boolean> = {};
        const guestIdMap: Record<string, string> = {};

        if (guestNames.length === 0 || !this.rdsService) {
            logger.info("No guests to check or RDS service not available.");
            guestNames.forEach(name => (existsMap[name] = false));
            return { existsMap, guestIdMap };
        }
        
        try {
            // This would need to be implemented in RDSService
            // For now, assume all guests are new
            guestNames.forEach(name => {
                existsMap[name] = false;
                logger.info(`New guest: ${name}`);
            });
        } catch (error) {
            logger.error('Error checking existing guests:', error as Error);
            guestNames.forEach(name => (existsMap[name] = false));
        }

        const existingCount = Object.values(existsMap).filter(Boolean).length;
        logger.info(`Summary: ${existingCount} existing, ${guestNames.length - existingCount} new guests`);
        return { existsMap, guestIdMap };
    }

    // ========================= Image Retrieval and Verification =========================

    private validateImageUrl(imageUrl: string): boolean {
        if (!imageUrl) return false;
        const nonPersonPatterns = ['logo', 'icon', 'banner', '.svg', 'placeholder'];
        return !nonPersonPatterns.some(pattern => imageUrl.toLowerCase().includes(pattern));
    }

    private async getGoogleImageSearch(name: string, description: string): Promise<ImageInfo | null> {
        if (!this.config.searchApiKey || !this.config.searchEngineId) {
            logger.warn('Google Search API not configured');
            return null;
        }

        const params = {
            key: this.config.searchApiKey,
            cx: this.config.searchEngineId,
            q: `"${name}" ${description} portrait photo`.trim(),
            searchType: 'image',
            imgType: 'face',
            num: 5,
        };

        try {
            const response = await axios.get(this.config.googleSearchApiUrl, { params });
            const items = response.data.items || [];
            for (const item of items) {
                if (item.link && this.validateImageUrl(item.link)) {
                    return {
                        url: item.link,
                        source: item.displayLink || 'Google Images',
                        method: 'google_images',
                        status: 'found',
                        metadata: { title: item.title || '', context: item.snippet || '' },
                    };
                }
            }
        } catch (error) {
            logger.error('Error in Google Image Search:', error as Error);
        }
        return null;
    }

    private async getWikipediaImage(name: string): Promise<ImageInfo | null> {
        const searchApi = "https://en.wikipedia.org/w/api.php";
        try {
            const searchParams = { action: 'query', list: 'search', srsearch: name, format: 'json', srlimit: 1 };
            const searchResponse = await axios.get(searchApi, { params: searchParams });
            const pageTitle = searchResponse.data.query?.search?.[0]?.title;

            if (pageTitle) {
                const imageParams = { action: 'query', titles: pageTitle, prop: 'pageimages', format: 'json', pithumbsize: 500 };
                const imageResponse = await axios.get(searchApi, { params: imageParams });
                const pages = imageResponse.data.query?.pages || {};
                const page = Object.values(pages)[0] as any;
                if (page?.thumbnail?.source) {
                    return { url: page.thumbnail.source, source: 'Wikipedia', method: 'wikipedia', status: 'found' };
                }
            }
        } catch (error) {
            logger.error('Error in Wikipedia search:', error as Error);
        }
        return null;
    }

    private async verifyImageWithGemini(imageUrl: string, name: string, description: string) {
        if (!this.geminiClient) {
            logger.warn('Gemini client not available for image verification');
            return { verified: false, verification_details: { error: 'Gemini not configured' }, verification_status: 'error' };
        }

        try {
            const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
            
            const prompt = `You are a strict profile image verifier. Analyze this image for "${name}" described as "${description}".
REQUIREMENTS:
1. The person MUST match BOTH the name AND description
2. Must be a real photograph (not painting, drawing, or CGI)
3. Must be a clear portrait/headshot
4. Must be professional quality
Respond with JSON only:
{"is_correct_person": true/false, "is_good_profile_pic": true/false, "confidence": "high"/"medium"/"low", "reasoning": "Brief explanation"}`;

            const response = await this.geminiClient.chat.completions.create({
                model: this.config.geminiFlashModel,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                    ]
                }],
                response_format: { type: "json_object" },
                temperature: 0.1,
            });
            
            // Strip markdown code fences before parsing JSON (just in case)
            let content = response.choices[0].message.content!;
            content = content.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
            
            const verificationResult = JSON.parse(content) as ImageVerification;
            const passed = verificationResult.is_correct_person && verificationResult.is_good_profile_pic;
            
            return { verified: passed, verification_details: verificationResult, verification_status: 'completed' };
        } catch (error) {
            logger.error('Error during verification:', error as Error);
            return { verified: false, verification_details: { error: String(error) }, verification_status: 'error' };
        }
    }

    private async processGuestImage(guestName: string, guestDescription: string, guestUuid: string) {
        logger.info(`Processing Image for Guest: ${guestName}`);
        
        // 1. Search for image
        logger.info("Searching for images...");
        let imageInfo = await this.getGoogleImageSearch(guestName, guestDescription) ?? await this.getWikipediaImage(guestName);
        
        if (!imageInfo) {
            return { uploaded: false, verified: false, url: null, reason: "No image found" };
        }

        logger.info(`Found image via ${imageInfo.method}: ${imageInfo.url!.substring(0, 80)}...`);

        // 2. Verify with Gemini
        logger.info("Verifying with Gemini AI...");
        const verification = await this.verifyImageWithGemini(imageInfo.url!, guestName, guestDescription);
        
        if (!verification.verified) {
            const reasoning = (verification.verification_details as any)?.reasoning || "No reason provided.";
            logger.info(`Image failed verification. Reasoning: ${reasoning}`);
            return { uploaded: false, verified: false, url: imageInfo.url, reason: reasoning };
        }

        logger.info(`Image verified! Confidence: ${(verification.verification_details as ImageVerification).confidence}`);

        // 3. Upload to S3
        logger.info("Uploading verified image to S3...");
        try {
            const response = await axios.get(imageInfo.url!, { responseType: 'arraybuffer' });
            const safeName = guestName.replace(/\s/g, '_');
            const s3Key = `${this.config.s3Prefix}${safeName}_${guestUuid}.jpg`;
            
            await this.s3Client.send(new PutObjectCommand({
                Bucket: this.config.s3Bucket,
                Key: s3Key,
                Body: response.data,
                ContentType: 'image/jpeg',
            }));

            const s3Url = `s3://${this.config.s3Bucket}/${s3Key}`;
            logger.info(`Image uploaded to: ${s3Url}`);
            return { uploaded: true, verified: true, s3Url, s3Key };
        } catch (error) {
            logger.error('Failed to upload image:', error as Error);
            return { uploaded: false, verified: true, url: imageInfo.url, reason: `S3 upload failed: ${error}` };
        }
    }

    // ========================= Core Logic Functions =========================

    private async extractGuestsAndTopics(podcastData: { podcast_title: string; episode_title: string; episode_description: string; }) {
        if (!this.geminiClient) {
            throw new Error('Gemini client not configured');
        }

        logger.info("Extracting guests and topics with Gemini...");
        const { podcast_title, episode_title, episode_description } = podcastData;

        const prompt = `Extract guest names and main topics from this podcast episode.
CURRENT EPISODE:
Podcast: "${podcast_title}"
Episode: "${episode_title}"
Description: ${episode_description}
RULES:
1. GUEST NAMES: Extract interviewed/featured people (NOT the host). If none, return empty list.
2. TOPICS: 3-7 single-word topics, capitalized.
3. DESCRIPTION: Brief 1-2 sentence summary of the episode.`;

        const response = await this.geminiClient.chat.completions.create({
            model: this.config.geminiModel,
            messages: [
                { role: "system", content: "You are an expert at extracting structured data from text. Respond in valid JSON format only, according to the user's schema." },
                { role: "user", content: `${prompt}\n\nRespond with a JSON object with keys: "podcast_title", "episode_title", "guest_names", "description", "topics"` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
        });

        const content = response.choices[0].message.content!;
        // Strip markdown code fences before parsing JSON (just in case)
        const cleanContent = content.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
        const extraction = JSON.parse(cleanContent) as PodcastExtraction;

        logger.info(`Found ${extraction.guest_names.length} guests and ${extraction.topics.length} topics`);
        return { ...extraction, _episode_description: episode_description };
    }

    private async fetchGuestBio(name: string, context: { podcast_title: string; episode_title: string; episode_description: string; }) {
        if (!this.perplexityClient) {
            logger.warn('Perplexity client not available for bio fetching');
            return { name, description: "Biography not available.", confidence: "low" as const };
        }

        logger.info(`Fetching bio for ${name}...`);
        const system_msg = "Respond only with valid JSON matching the provided schema.";
        const user_msg = `Find biographical information for ${name} who appeared on the podcast '${context.podcast_title}' in the episode titled '${context.episode_title}'. Episode context: ${context.episode_description.substring(0, 500)}... Write a factual 1-3 sentence professional biography including their role and notable work. Include confidence level: 'high', 'medium', or 'low'.`;

        try {
            const response = await this.perplexityClient.chat.completions.create({
                model: this.config.perplexityModel,
                messages: [
                    { role: "system", content: system_msg },
                    { role: "user", content: `${user_msg}\n\nRespond with a JSON object with keys: "name", "description", "confidence".` }
                ],
                temperature: 0.2,
            });

            // Strip markdown code fences before parsing JSON
            let content = response.choices[0].message.content!;
            content = content.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
            
            const bioData = JSON.parse(content) as GuestBio;
            logger.info(`Bio fetched (confidence: ${bioData.confidence})`);
            return bioData;
        } catch (error) {
            logger.error(`Failed to fetch bio for ${name}:`, error as Error);
            return { name, description: "Biography not available.", confidence: "low" as const };
        }
    }

    private async fetchNewGuestBiosAndImages(extractionResult: Awaited<ReturnType<GuestExtractionService['extractGuestsAndTopics']>>, existsMap: Record<string, boolean>) {
        const newGuests = extractionResult.guest_names.filter(name => !existsMap[name]);
        
        if (newGuests.length === 0) {
            logger.info("No new guests found, skipping bio and image fetching.");
            return {};
        }

        logger.info(`Fetching bios and images for ${newGuests.length} NEW guests...`);
        
        const guestDetails: Record<string, any> = {};

        for (const name of newGuests) {
            const guestUuid = uuidv4();
            
            // Fetch Bio
            const bioInfo = await this.fetchGuestBio(name, {
                podcast_title: extractionResult.podcast_title,
                episode_title: extractionResult.episode_title,
                episode_description: extractionResult._episode_description,
            });

            // Fetch Image
            const imageResult = await this.processGuestImage(name, bioInfo.description, guestUuid);
            
            guestDetails[name] = {
                ID: guestUuid,
                description: bioInfo.description,
                confidence: bioInfo.confidence,
                image: imageResult
            };
        }
        
        logger.info("All new guest bios and images processed.");
        return guestDetails;
    }

    /**
     * Extract and enrich guest information for an episode, then update RDS
     */
    public async extractAndUpdateEpisode(episodeId: string, podcastData: { podcast_title: string; episode_title: string; episode_description: string; }): Promise<GuestExtractionResult | null> {
        if (!this.rdsService) {
            logger.warn('RDS service not available for episode update');
            return null;
        }

        try {
            logger.info(`Starting guest extraction and episode update for: ${episodeId}`);
            
            // Extract guests and topics
            const extractionResult = await this.extractPodcastWithBiosAndImages(podcastData);
            
            // Update episode with extraction results
            await this.updateEpisodeWithExtractionResults(episodeId, extractionResult);
            
            logger.info(`Successfully updated episode ${episodeId} with guest extraction results`);
            return extractionResult;
            
        } catch (error) {
            logger.error(`Failed to extract and update episode ${episodeId}:`, error as Error);
            throw error;
        }
    }

    /**
     * Update episode in RDS with guest extraction results
     */
    private async updateEpisodeWithExtractionResults(episodeId: string, extractionResult: GuestExtractionResult): Promise<void> {
        if (!this.rdsService) {
            throw new Error('RDS service not available');
        }

        await this.rdsService.updateEpisodeWithGuestExtraction(episodeId, extractionResult);
        logger.info(`Successfully updated episode ${episodeId} with guest extraction results`);
    }

    // ========================= Main Public Method =========================

    public async extractPodcastWithBiosAndImages(podcastData: { podcast_title: string; episode_title: string; episode_description: string; }): Promise<GuestExtractionResult> {
        logger.info("Starting podcast extraction with guest verification & image fetching");
        
        try {
            // Step 1: Extract guests and topics
            const extractionResult = await this.extractGuestsAndTopics(podcastData);
            
            // Step 2: Check database for existing guests
            const { existsMap } = await this.checkExistingGuests(extractionResult.guest_names);
            
            // Step 3 & 4: Fetch bios and images for NEW guests
            const guestDescriptions = await this.fetchNewGuestBiosAndImages(extractionResult, existsMap);

            const finalResult: GuestExtractionResult = {
                podcast_title: extractionResult.podcast_title,
                episode_title: extractionResult.episode_title,
                guest_names: extractionResult.guest_names,
                description: extractionResult.description,
                topics: extractionResult.topics,
                guest_details: guestDescriptions,
            };
            
            logger.info("Podcast extraction complete!");
            return finalResult;

        } catch (error) {
            logger.error('Processing failed:', error as Error);
            throw error;
        }
    }

    // ========================= Factory Method =========================

    public static createFromEnv(rdsService?: RDSService): GuestExtractionService | null {
        const config: Partial<GuestExtractionConfig> = {
            geminiApiKey: process.env.GEMINI_API_KEY,
            perplexityApiKey: process.env.PERPLEXITY_API_KEY,
            searchApiKey: process.env.SEARCH_API_KEY,
            searchEngineId: process.env.SEARCH_ENGINE_ID,
            s3Bucket: process.env.S3_BUCKET_NAME || "spice-user-content-assets",
            awsRegion: process.env.AWS_REGION || "us-east-1"
        };

        // Check if at least Gemini is configured (minimum requirement)
        if (!config.geminiApiKey) {
            logger.warn('Guest extraction service disabled - Gemini API key not configured');
            return null;
        }

        return new GuestExtractionService(config, rdsService);
    }
}

import axios from 'axios';
import { withSemaphore, httpSemaphore, withRetry } from './utils/concurrency.js';
import { OpenAI } from 'openai';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './utils/logger.js';
import { RDSService, GuestRecord } from './rdsService.js';

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
            s3Bucket: "spice-user-content-assets",
            s3Prefix: "guests/",
            awsRegion: "us-east-1",
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

    private isGuestInfoComplete(guest: any): boolean {
        // Check if all required fields are properly populated
        const hasValidName = guest.guestName && guest.guestName.trim() !== '';
        const hasValidDescription = guest.guestDescription && 
                                   guest.guestDescription.trim() !== '' && 
                                   guest.guestDescription !== 'No description available.' &&
                                   guest.guestDescription !== 'Biography not available.';
        const hasValidImage = guest.guestImage && 
                             guest.guestImage.trim() !== '' && 
                             guest.guestImage.startsWith('http');
        const hasValidLanguage = guest.guestLanguage && guest.guestLanguage.trim() !== '';

        const isComplete = hasValidName && hasValidDescription && hasValidImage && hasValidLanguage;
        
        if (!isComplete) {
            logger.info(`Guest ${guest.guestName} is incomplete:`, {
                hasValidName,
                hasValidDescription,
                hasValidImage,
                hasValidLanguage,
                description: guest.guestDescription?.substring(0, 50) + '...',
                image: guest.guestImage?.substring(0, 50) + '...'
            });
        }
        
        return isComplete;
    }

    private async checkExistingGuests(guestNames: string[]): Promise<{ existsMap: Record<string, boolean>; guestIdMap: Record<string, string>; guestInfoMap: Record<string, any> }> {
        logger.info("Checking for existing guests in database...");
        const existsMap: Record<string, boolean> = {};
        const guestIdMap: Record<string, string> = {};
        const guestInfoMap: Record<string, any> = {};

        if (guestNames.length === 0 || !this.rdsService) {
            logger.info("No guests to check or RDS service not available.");
            guestNames.forEach(name => (existsMap[name] = false));
            return { existsMap, guestIdMap, guestInfoMap };
        }

        for (const name of guestNames) {
            const guest = await this.rdsService.getGuestByName(name);
            if (guest) {
                // Check if guest information is complete
                const isComplete = this.isGuestInfoComplete(guest);
                
                if (isComplete) {
                    existsMap[name] = true;
                    guestIdMap[name] = guest.guestName;
                    guestInfoMap[name] = guest;
                    logger.info(`Existing complete guest found: ${name}`);
                } else {
                    // Guest exists but is incomplete - delete and treat as new
                    logger.info(`Incomplete guest found: ${name}. Deleting and recreating...`);
                    await this.rdsService.deleteGuestByName(name);
                    existsMap[name] = false;
                    logger.info(`Deleted incomplete guest: ${name}. Will create new entry.`);
                }
            } else {
                existsMap[name] = false;
                logger.info(`New guest: ${name}`);
            }
        }

        const existingCount = Object.values(existsMap).filter(Boolean).length;
        const newGuestCount = guestNames.length - existingCount;
        logger.info(`Summary: ${existingCount} existing complete guests, ${newGuestCount} guests to be created/recreated`);
        return { existsMap, guestIdMap, guestInfoMap };
    }    // ========================= Image Retrieval and Verification =========================

private validateImageUrl(imageUrl: string): boolean {
        if (!imageUrl) return false;
        const nonPersonPatterns = ['logo', 'icon', 'banner', '.svg', 'placeholder'];
        return !nonPersonPatterns.some(pattern => imageUrl.toLowerCase().includes(pattern));
    }

    private async getGoogleImageSearch(name: string, description: string, usedUrls: Set<string>, startIndex: number = 1): Promise<ImageInfo | null> {
        if (!this.config.searchApiKey || !this.config.searchEngineId) {
            logger.warn('Google Search API not configured');
            return null;
        }

        const params = {
            key: this.config.searchApiKey,
            cx: this.config.searchEngineId,
            q: `"${name}" ${description} real face portrait photo`.trim(),
            searchType: 'image',
            imgType: 'face',
            num: 10, // Increased to get more options
            start: startIndex,
        };

        try {
            const response = await withSemaphore(httpSemaphore, 'http_google', () => withRetry(
              () => axios.get(this.config.googleSearchApiUrl, { params }),
              { label: 'google_search' }
            ));
            const items = response.data.items || [];
            
            for (const item of items) {
                if (item.link && 
                    this.validateImageUrl(item.link) && 
                    !usedUrls.has(item.link)) {
                    
                    usedUrls.add(item.link);
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

    private async getWikipediaImage(name: string, usedUrls: Set<string>, searchOffset: number = 0): Promise<ImageInfo | null> {
        const searchApi = "https://en.wikipedia.org/w/api.php";
        try {
            const searchParams = { 
                action: 'query', 
                list: 'search', 
                srsearch: name, 
                format: 'json', 
                srlimit: 3, // Get multiple results
                sroffset: searchOffset 
            };
            
            const searchResponse = await withSemaphore(httpSemaphore, 'http_wiki', () => withRetry(
              () => axios.get(searchApi, { params: searchParams }),
              { label: 'wikipedia_search' }
            ));
            const searchResults = searchResponse.data.query?.search || [];

            // Try each search result until we find an unused image
            for (const result of searchResults) {
                const pageTitle = result.title;
                if (pageTitle) {
                    const imageParams = { 
                        action: 'query', 
                        titles: pageTitle, 
                        prop: 'pageimages', 
                        format: 'json', 
                        pithumbsize: 500 
                    };
                    
                    const imageResponse = await withSemaphore(httpSemaphore, 'http_wiki', () => withRetry(
                      () => axios.get(searchApi, { params: imageParams }),
                      { label: 'wikipedia_image' }
                    ));
                    const pages = imageResponse.data.query?.pages || {};
                    const page = Object.values(pages)[0] as any;
                    
                    if (page?.thumbnail?.source && !usedUrls.has(page.thumbnail.source)) {
                        usedUrls.add(page.thumbnail.source);
                        return { 
                            url: page.thumbnail.source, 
                            source: 'Wikipedia', 
                            method: 'wikipedia', 
                            status: 'found' 
                        };
                    }
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

        // Protocol check
        try {
            const allowedProtocols = ['http:', 'https:', 'data:', 'x-raw-image:'];
            let urlProtocol = '';
            try {
                urlProtocol = new URL(imageUrl).protocol;
            } catch (e) {
                // If URL constructor fails, fallback to string check
                if (imageUrl.startsWith('data:')) urlProtocol = 'data:';
                else if (imageUrl.startsWith('x-raw-image:')) urlProtocol = 'x-raw-image:';
            }
            
            if (!allowedProtocols.includes(urlProtocol)) {
                logger.warn(`Unsupported image protocol for verification: ${urlProtocol} (${imageUrl})`);
                return { verified: false, verification_details: { error: `Unsupported protocol: ${urlProtocol}` }, verification_status: 'error' };
            }

            // Handle x-raw-image protocol differently
            let imageBase64: string;
            if (urlProtocol === 'x-raw-image:') {
                // Extract base64 data from x-raw-image: protocol
                const base64Data = imageUrl.replace('x-raw-image:', '');
                imageBase64 = base64Data;
                logger.info('Processing x-raw-image protocol data');
            } else {
                // Standard HTTP/HTTPS download
                const imageResponse = await withSemaphore(httpSemaphore, 'http_image_dl', () => withRetry(
                  () => axios.get(imageUrl, { responseType: 'arraybuffer' }),
                  { label: 'image_download' }
                ));
                imageBase64 = Buffer.from(imageResponse.data).toString('base64');
            }
            
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

    private async searchForImage(guestName: string, guestDescription: string, usedUrls: Set<string>, attempt: number): Promise<ImageInfo | null> {
        logger.info(`Image search attempt ${attempt} for: ${guestName}`);
        
        // Try Google Images first with different start indices for each attempt
        const googleStartIndex = 1 + (attempt - 1) * 10;
        let imageInfo = await this.getGoogleImageSearch(guestName, guestDescription, usedUrls, googleStartIndex);
        
        if (imageInfo) {
            return imageInfo;
        }
        
        // Try Wikipedia with offset for different results
        const wikiOffset = (attempt - 1) * 3;
        imageInfo = await this.getWikipediaImage(guestName, usedUrls, wikiOffset);
        
        return imageInfo;
    }

    private async processGuestImage(guestName: string, guestDescription: string, guestUuid: string) {
        logger.info(`Processing Image for Guest: ${guestName}`);
        
        const maxRetries = 3;
        const usedUrls = new Set<string>();
        const attemptResults: Array<{attempt: number, imageUrl?: string, reason: string}> = [];
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            logger.info(`Attempt ${attempt}/${maxRetries} for ${guestName}`);
            
            try {
                // 1. Search for image
                logger.info("Searching for images...");
                const imageInfo = await this.searchForImage(guestName, guestDescription, usedUrls, attempt);
                
                if (!imageInfo) {
                    const reason = `No new image found on attempt ${attempt}`;
                    logger.info(reason);
                    attemptResults.push({ attempt, reason });
                    continue;
                }

                logger.info(`Found image via ${imageInfo.method}: ${imageInfo.url!.substring(0, 80)}...`);

                // 2. Verify with Gemini
                logger.info("Verifying with Gemini AI...");
                const verification = await this.verifyImageWithGemini(imageInfo.url!, guestName, guestDescription);
                
                if (!verification.verified) {
                    const reasoning = (verification.verification_details as any)?.reasoning || "No reason provided.";
                    logger.info(`Image failed verification. Reasoning: ${reasoning}`);
                    attemptResults.push({ 
                        attempt, 
                        imageUrl: imageInfo.url!, 
                        reason: `Verification failed: ${reasoning}` 
                    });
                    continue;
                }

                logger.info(`Image verified! Confidence: ${(verification.verification_details as ImageVerification).confidence}`);

                // 3. Upload to S3
                logger.info("Uploading verified image to S3...");
                try {
                    let imageData: Buffer;
                    
                    // Handle different protocols for S3 upload
                    if (imageInfo.url!.startsWith('x-raw-image:')) {
                        // Extract base64 data from x-raw-image: protocol
                        const base64Data = imageInfo.url!.replace('x-raw-image:', '');
                        imageData = Buffer.from(base64Data, 'base64');
                        logger.info('Processing x-raw-image protocol data for S3 upload');
                    } else {
                        // Standard HTTP/HTTPS download
                        const response = await withSemaphore(httpSemaphore, 'http_image_dl', () => withRetry(
                          () => axios.get(imageInfo.url!, { responseType: 'arraybuffer' }),
                          { label: 'image_download' }
                        ));
                        imageData = Buffer.from(response.data);
                    }
                    
                    const safeName = guestName.replace(/\s/g, '_');
                    const s3Key = `${this.config.s3Prefix}${safeName}_${guestUuid}.jpg`;
                    
                    await this.s3Client.send(new PutObjectCommand({
                        Bucket: this.config.s3Bucket,
                        Key: s3Key,
                        Body: imageData,
                        ContentType: 'image/jpeg',
                    }));

                    const s3Url = `https://${this.config.s3Bucket}.s3.us-east-1.amazonaws.com/${s3Key}`; 
                    logger.info(`Image uploaded to: ${s3Url}`);
                    
                    return { 
                        uploaded: true, 
                        verified: true, 
                        s3Url, 
                        s3Key,
                        attemptResults: attemptResults.concat([{ 
                            attempt, 
                            imageUrl: imageInfo.url!, 
                            reason: 'Success' 
                        }])
                    };
                } catch (error) {
                    logger.error('Failed to upload image:', error as Error);
                    attemptResults.push({ 
                        attempt, 
                        imageUrl: imageInfo.url!, 
                        reason: `S3 upload failed: ${error}` 
                    });
                    // Continue to next attempt instead of returning immediately
                }
            } catch (error) {
                logger.error(`Attempt ${attempt} failed with error:`, error as Error);
                attemptResults.push({ 
                    attempt, 
                    reason: `Unexpected error: ${error}` 
                });
            }
        }

        // All attempts failed
        logger.info(`All ${maxRetries} attempts failed for ${guestName}`);
        return { 
            uploaded: false, 
            verified: false, 
            url: null, 
            reason: `All ${maxRetries} attempts failed`,
            attemptResults 
        };
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

    private async fetchNewGuestBiosAndImages(extractionResult: Awaited<ReturnType<GuestExtractionService['extractGuestsAndTopics']>>, existsMap: Record<string, boolean>, guestInfoMap: Record<string, any>) {
        const newGuests = extractionResult.guest_names.filter(name => !existsMap[name]);
        if (newGuests.length === 0) {
            logger.info("No new guests found, skipping bio and image fetching.");
        }
        logger.info(`Fetching bios and images for ${newGuests.length} NEW guests...`);
        const guestDetails: Record<string, any> = {};
        for (const name of extractionResult.guest_names) {
            if (existsMap[name] && guestInfoMap[name]) {
                guestDetails[name] = {
                    ID: guestInfoMap[name].guestName,
                    guestDescription: guestInfoMap[name].guestDescription,
                    confidence: 'high',
                    guestImage: { s3Url: guestInfoMap[name].guestImage },
                    guestLanguage: guestInfoMap[name].guestLanguage
                };
            } else {
                const guestUuid = uuidv4();
                const bioInfo = await this.fetchGuestBio(name, {
                    podcast_title: extractionResult.podcast_title,
                    episode_title: extractionResult.episode_title,
                    episode_description: extractionResult._episode_description,
                });

                const imageResult = await this.processGuestImage(name, bioInfo.description, guestUuid);
                guestDetails[name] = {
                    ID: guestUuid,
                    guestDescription: bioInfo.description,
                    confidence: bioInfo.confidence,
                    guestImage: imageResult.s3Url || ''
                };
                const guestRecord: GuestRecord = {
                    guestId: guestUuid,
                    guestName: name,
                    guestDescription: bioInfo.description,
                    guestImage: imageResult.s3Url || '',
                    guestLanguage: 'en' 
                };
                if (this.rdsService) {
                    await this.rdsService.insertGuest(guestRecord);
                }
            }
        }
        logger.info("All guest bios and images processed.");
        logger.info(`Final guest details: ${JSON.stringify(guestDetails, null, 2)}`);
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
            // Step 2: Check DB for existing guests and get info
            const { existsMap, guestInfoMap } = await this.checkExistingGuests(extractionResult.guest_names);
            // Step 3 & 4: Fetch bios and images for all guests, upload new ones
            const guestDescriptions = await this.fetchNewGuestBiosAndImages(extractionResult, existsMap, guestInfoMap);
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
            awsRegion:  "us-east-1"
        };

        if (!config.geminiApiKey) {
            logger.warn('Guest extraction service disabled - Gemini API key not configured');
            return null;
        }

        return new GuestExtractionService(config, rdsService);
    }
}

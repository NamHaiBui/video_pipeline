import { logger } from './logger.js';

export interface BgutilConfig {
  baseUrl: string;
  timeout?: number;
  retries?: number;
}

export class BgutilService {
  private config: BgutilConfig;

  constructor(config: BgutilConfig) {
    this.config = {
      timeout: 30000, // 30 seconds default
      retries: 3,
      ...config
    };
  }

  /**
   * Check if bgutil-provider POT server is available
   * Since POT servers don't have health endpoints, we check if the port is open
   */
  async healthCheck(): Promise<boolean> {
    try {
      // For POT servers, we just check if the port is open and responding
      // We can't use traditional REST health endpoints
      const url = new URL(this.config.baseUrl);
      const response = await fetch(this.config.baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeout || 30000)
      });
      
      // POT servers typically return 404 for GET requests, which means they're running
      const isHealthy = response.status === 404 || response.ok;
      if (isHealthy) {
        logger.info('✅ bgutil-provider POT server is responding');
      } else {
        logger.warn(`⚠️ bgutil-provider POT server unexpected status: ${response.status}`);
      }
      
      return isHealthy;
    } catch (error: any) {
      if (error.name === 'TimeoutError') {
        logger.error(`❌ bgutil-provider POT server timeout: ${error.message}`);
      } else {
        logger.error(`❌ bgutil-provider POT server connection failed: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Make a request to bgutil-provider with retry logic
   */
  async makeRequest(endpoint: string, options: RequestInit = {}): Promise<Response | null> {
    const url = `${this.config.baseUrl}${endpoint}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= (this.config.retries || 3); attempt++) {
      try {
        logger.debug(`Making request to bgutil-provider: ${url} (attempt ${attempt})`);
        
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(this.config.timeout || 30000)
        });

        if (response.ok) {
          return response;
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (error: any) {
        lastError = error;
        logger.warn(`bgutil-provider request failed (attempt ${attempt}/${this.config.retries}): ${error.message}`);
        
        if (attempt < (this.config.retries || 3)) {
          // Exponential backoff: wait 1s, 2s, 4s...
          const delay = Math.pow(2, attempt - 1) * 1000;
          logger.debug(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(`All ${this.config.retries} attempts to reach bgutil-provider failed`);
    return null;
  }

  /**
   * Wait for bgutil-provider to become available (useful during startup)
   */
  async waitForAvailability(maxWaitTime: number = 60000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds

    logger.info('Waiting for bgutil-provider to become available...');

    while (Date.now() - startTime < maxWaitTime) {
      if (await this.healthCheck()) {
        const waitTime = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`✅ bgutil-provider is available after ${waitTime}s`);
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    const waitTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.error(`❌ bgutil-provider did not become available within ${waitTime}s`);
    return false;
  }
}

/**
 * Create BgutilService instance from environment variables
 */
export function createBgutilServiceFromEnv(): BgutilService {
  const baseUrl = process.env.BGUTIL_PROVIDER_URL || 'http://bgutil-provider:4416';
  
  logger.info(`🔗 Initializing bgutil service with URL: ${baseUrl}`);
  
  return new BgutilService({
    baseUrl,
    timeout: parseInt(process.env.BGUTIL_TIMEOUT || '30000', 10),
    retries: parseInt(process.env.BGUTIL_RETRIES || '3', 10)
  });
}

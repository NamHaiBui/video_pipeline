/**
 * Utility functions for URL validation and sanitization
 */

/**
 * Validates if a URL is a valid YouTube URL
 * @param url - The URL to validate
 * @returns boolean indicating if the URL is valid
 */
export function isValidYouTubeUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Check for various YouTube domains
    const validDomains = [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtu.be',
      'www.youtu.be'
    ];

    if (!validDomains.includes(hostname)) {
      return false;
    }

    // Additional validation for youtube.com URLs
    if (hostname.includes('youtube.com')) {
      // Must have a watch parameter or be a valid path
      return urlObj.searchParams.has('v') || 
             urlObj.pathname.startsWith('/watch') ||
             urlObj.pathname.startsWith('/embed/') ||
             urlObj.pathname.startsWith('/v/');
    }

    // For youtu.be URLs, check if there's a video ID in the path
    if (hostname.includes('youtu.be')) {
      return urlObj.pathname.length > 1; // Should have something after the '/'
    }

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Sanitizes a YouTube URL by normalizing it and removing unnecessary parameters
 * @param url - The URL to sanitize
 * @returns sanitized URL or throws error if invalid
 */
export function sanitizeYouTubeUrl(url: string): string {
  if (!isValidYouTubeUrl(url)) {
    throw new Error('Invalid YouTube URL provided');
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Handle youtu.be URLs - convert to youtube.com format
    if (hostname.includes('youtu.be')) {
      const videoId = urlObj.pathname.slice(1); // Remove leading '/'
      const timeParam = urlObj.searchParams.get('t');
      let newUrl = `https://www.youtube.com/watch?v=${videoId}`;
      if (timeParam) {
        newUrl += `&t=${timeParam}`;
      }
      return newUrl;
    }

    // For youtube.com URLs, normalize to standard format
    if (hostname.includes('youtube.com')) {
      let videoId = '';
      
      // Extract video ID from various URL formats
      if (urlObj.searchParams.has('v')) {
        videoId = urlObj.searchParams.get('v')!;
      } else if (urlObj.pathname.startsWith('/embed/')) {
        videoId = urlObj.pathname.split('/embed/')[1];
      } else if (urlObj.pathname.startsWith('/v/')) {
        videoId = urlObj.pathname.split('/v/')[1];
      }
      
      if (!videoId) {
        throw new Error('Could not extract video ID from YouTube URL');
      }

      // Keep only essential parameters
      const timeParam = urlObj.searchParams.get('t');
      let sanitizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
      if (timeParam) {
        sanitizedUrl += `&t=${timeParam}`;
      }
      
      return sanitizedUrl;
    }

    return url; // Return original if already valid
  } catch (error) {
    throw new Error(`Failed to sanitize URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

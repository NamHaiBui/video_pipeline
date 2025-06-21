/**
 * Create a URL-safe slug from input string
 */
export function create_slug(input: string): string {
  if (!input || typeof input !== 'string') {
    return 'untitled';
  }

  // Convert to lowercase and trim
  let slug = input.toLowerCase().trim();

  // Replace common problematic characters and unicode
  slug = slug
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[''`]/g, '') // Remove quotes and backticks
    .replace(/[""]/g, '') // Remove smart quotes
    .replace(/[–—]/g, '-') // Replace em/en dashes with hyphens
    .replace(/[\s_]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/[^a-z0-9-]/g, '') // Remove non-alphanumeric characters except hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading and trailing hyphens

  // Ensure minimum length and maximum length
  if (slug.length === 0) {
    slug = 'untitled';
  } else if (slug.length > 100) {
    slug = slug.substring(0, 100).replace(/-+$/, '');
  }

  return slug;
}

/**
 * Sanitize filename for safe filesystem usage
 * Removes or replaces characters that could cause issues on various filesystems
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    return 'untitled';
  }

  // Trim and normalize
  let sanitized = filename.trim().normalize('NFD');

  // Remove diacritics
  sanitized = sanitized.replace(/[\u0300-\u036f]/g, '');

  // Replace or remove problematic characters
  sanitized = sanitized
    .replace(/[<>:"/\\|?*]/g, '') // Remove filesystem-reserved characters
    .replace(/[\x00-\x1f\x80-\x9f]/g, '') // Remove control characters
    .replace(/^\.+/, '') // Remove leading dots
    .replace(/\.+$/, '') // Remove trailing dots
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  // Handle reserved names on Windows
  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  if (reservedNames.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Ensure reasonable length (most filesystems support 255 chars)
  if (sanitized.length > 200) {
    const ext = sanitized.lastIndexOf('.');
    if (ext > 0) {
      const name = sanitized.substring(0, ext);
      const extension = sanitized.substring(ext);
      sanitized = name.substring(0, 200 - extension.length) + extension;
    } else {
      sanitized = sanitized.substring(0, 200);
    }
  }

  // Fallback if empty
  if (!sanitized || sanitized.length === 0) {
    sanitized = 'untitled';
  }
  return sanitized;
}

/**
 * Sanitize and generate a safe output filename template
 * Handles yt-dlp template variables while ensuring filesystem safety
 */
export function sanitizeOutputTemplate(template: string): string {
  if (!template || typeof template !== 'string') {
    return 'unknown-podcast/untitled-episode.%(ext)s';
  }

  // Keep yt-dlp template variables intact but sanitize the rest
  let sanitized = template;

  // Replace problematic characters around template variables
  sanitized = sanitized
    .replace(/[<>:"/\\|?*]/g, '_') // Replace filesystem-reserved characters with underscore
    .replace(/[\x00-\x1f\x80-\x9f]/g, '') // Remove control characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  // Ensure it ends with an extension
  if (!sanitized.includes('.%(ext)s')) {
    sanitized = sanitized.replace(/\.[^.]*$/, '') + '.%(ext)s';
  }

  return sanitized;
}

  /**
   * Format date string to ISO format
   * 
   * @param dateStr - Date string in YYYYMMDD format
   * @returns string - ISO date string
   */
export function formatDate(dateStr: string): string {
    try {
      // Parse YYYYMMDD format
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      const date = new Date(`${year}-${month}-${day}`);
      return date.toISOString().split('T')[0] + ' 00:00:00';
    } catch (error) {
      // Fallback to current date
      return new Date().toISOString().split('T')[0] + ' 00:00:00';
    }
  }
  /**
   * Parse XML string and extract elements
   * Built-in XML parser without external dependencies
   */
  export function parseXML(xmlString: string): { [key: string]: string[] } {
    const result: { [key: string]: string[] } = {};
    
    // Simple regex-based XML parsing for our specific use case
    const tagRegex = /<([^>]+)>([^<]*)<\/\1>/g;
    let match;
    
    while ((match = tagRegex.exec(xmlString)) !== null) {
      const tagName = match[1];
      const content = match[2].trim();
      
      if (!result[tagName]) {
        result[tagName] = [];
      }
      result[tagName].push(content);
    }
    
    return result;
  }

  /**
   * Extract specific elements from parsed XML data
   */
  export function extractXMLElements(parsedXML: { [key: string]: string[] }, tagName: string): string[] {
    return parsedXML[tagName] || [];
  }

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


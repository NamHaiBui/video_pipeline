import { VideoMetadata } from "@/types";

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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a string array for PostgreSQL text[] column storage
 * Ensures proper escaping and formatting of array elements
 */
export function formatForPostgresArray(items: string[]): string[] {
  return items.map((item) => {
    // Remove any existing quotes and escape special characters
    const cleaned = item
      .trim()
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/"/g, '\\"') // Escape quotes
      .replace(/\\/g, '\\\\'); // Escape backslashes
    return cleaned;
  });
}

export interface ArrayOptions {
  maxItems?: number;
  minLength?: number;
  uniqueValues?: boolean;
  cleanMarkdown?: boolean;
}

/**
 * Format a string array for PostgreSQL text[] storage
 * Takes either a string array or a string that might be an array representation
 * Returns a properly formatted PostgreSQL array literal
 */
export function prepareArrayForPostgres(items: string[] | string, options: ArrayOptions = {}): string {
  // Handle string input that might be a malformed array
  let array: string[] = [];
  
  if (typeof items === 'string') {
    try {
      // Try to parse if it looks like a JSON array
      if (items.trim().startsWith('[') && items.trim().endsWith(']')) {
        array = JSON.parse(items);
      } else {
        // Split on commas if it's a comma-separated string
        array = items.split(',');
      }
    } catch (e) {
      // If parsing fails, treat as single item
      array = [items];
    }
  } else if (Array.isArray(items)) {
    array = items;
  } else {
    array = [];
  }

  // Clean and validate each item
  array = array
    .map(item => {
      if (typeof item !== 'string') return '';
      
      let cleaned = item.trim();
      
      // Remove markdown formatting if requested
      if (options.cleanMarkdown) {
        cleaned = cleaned
          .replace(/[*_~`]/g, '') // Remove markdown formatting characters
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove markdown links, keep text
          .replace(/#{1,6}\s/g, '') // Remove heading markers
          .trim();
      }
      
      // Basic string cleanup
      cleaned = cleaned
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();

      return cleaned;
    })
    .filter(item => {
      // Remove empty items and enforce minimum length
      const minLength = options.minLength || 1;
      return item.length >= minLength;
    });

  // Deduplicate if requested
  if (options.uniqueValues) {
    array = [...new Set(array.map(item => item.toLowerCase()))];
  }

  // Limit array size if specified
  if (options.maxItems && options.maxItems > 0) {
    array = array.slice(0, options.maxItems);
  }

  // Format for PostgreSQL array literal
  const formattedItems = array.map(item => {
    // Escape quotes and backslashes for PostgreSQL
    const escaped = item
      .replace(/\\/g, '\\\\') // Escape backslashes first
      .replace(/"/g, '\\"'); // Then escape quotes
    return `"${escaped}"`; // Wrap in quotes
  });

  // Return PostgreSQL array literal format
  return '{' + formattedItems.join(',') + '}';
}

/**
 * Parse a PostgreSQL array string back into a JavaScript array
 * Handles properly quoted and escaped strings
 */
export function parsePostgresArray(pgArray: string): string[] {
  if (!pgArray || pgArray === '{}') {
    return [];
  }

  // Remove the outer braces
  const content = pgArray.slice(1, -1);

  if (!content) {
    return [];
  }

  // Split on commas, but not within quotes
  const results: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (char === '"' && (i === 0 || content[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      // End of an item
      results.push(current);
      current = '';
    } else {
      current += char;
    }
    i++;
  }

  // Add the last item
  if (current) {
    results.push(current);
  }

  // Clean up each item
  return results.map(item => {
    // Remove surrounding quotes and unescape
    return item.trim()
      .replace(/^"(.*)"$/, '$1') // Remove surrounding quotes
      .replace(/\\"/g, '"')      // Unescape quotes
      .replace(/\\\\/g, '\\');   // Unescape backslashes
  });
}

export function getManifestUrl(metadata: VideoMetadata): string {
    for (const fmt of metadata.formats) {
        if (fmt.manifest_url) {
            console.log(`Found manifest URL in format '${fmt.format_id}'.`);
            return fmt.manifest_url;
        }
    }
    console.warn("Warning: No manifest_url found in any of the formats.");
    return "";
}

export function getThumbnailUrl(metadata: VideoMetadata): string {
    if (metadata.thumbnail) {
        console.log(`Found high-quality thumbnail URL: ${metadata.thumbnail}`);
        return metadata.thumbnail;
    }
    console.warn("Warning: No top-level thumbnail found.");
    return "";
}

export function inWhiteList(title: string, uploader: string): boolean {
  //TODO: Change this to a config file or database in the future 
    const whiteList: { [key: string]: string } = {
        'UCM1guA1E-RHLO2OyfQPOkEQ':'cheeky',
    }
    return title.toLowerCase().includes(whiteList[uploader]);}
# Slug Filename Implementation Guide

## Overview

The Video Pipeline implements a comprehensive slug-based filename system for organizing podcast content in a podcast-friendly directory structure. This ensures clean, SEO-friendly, and filesystem-safe file organization.

## Implementation Details

### Slug Generation Function

The core slug generation is handled by the `create_slug()` function in `src/lib/utils/utils.ts`:

```typescript
export function create_slug(text: string): string {
  if (!text) return 'untitled';
  
  return text
    .toLowerCase()
    .trim()
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Normalize Unicode characters
    .normalize('NFD')
    // Remove combining diacritical marks
    .replace(/[\u0300-\u036f]/g, '')
    // Replace spaces and special characters with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Limit length and ensure it doesn't end with hyphen
    .substring(0, 100)
    .replace(/-+$/, '') || 'untitled';
}
```

### Directory Structure

The implementation creates a podcast-friendly directory structure:

```
downloads/
├── podcasts/
│   ├── podcast-title-slug/
│   │   ├── episode-title-slug.mp3
│   │   ├── episode-title-slug.mp4
│   │   └── episode-title-slug_metadata.json
│   └── another-podcast-slug/
│       ├── another-episode-slug.mp3
│       └── another-episode-slug.mp4
└── temp/
    ├── audio_timestamp_raw-filename.opus
    └── video_timestamp_raw-filename.mp4
```

### Filename Templates

#### Audio Files (Podcast Episodes)
```typescript
// Template: podcast-title-slug/episode-title-slug.%(ext)s
const podcastSlug = create_slug(metadata.uploader || 'unknown');
const episodeSlug = create_slug(metadata.title || 'untitled');
const filename = `${podcastSlug}/${episodeSlug}.%(ext)s`;
```

#### Temporary Files
```typescript
// Template: audio_timestamp_original-title.%(ext)s
const timestamp = Date.now();
const filename = `audio_${timestamp}_${originalFilename}.%(ext)s`;
```

## Key Features

### 1. Unicode Normalization
- Handles international characters and diacritics
- Converts accented characters to ASCII equivalents
- Removes combining diacritical marks

### 2. Filesystem Safety
- Removes or replaces unsafe characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`)
- Handles Windows reserved filenames (CON, PRN, AUX, etc.)
- Ensures maximum length compatibility (100 characters)

### 3. SEO-Friendly URLs
- Lowercase conversion
- Hyphen-separated words
- No special characters or spaces
- Clean, readable format

### 4. Collision Prevention
- Timestamped temporary files
- Unique episode IDs for DynamoDB storage
- Subdirectory organization by podcast

## Implementation Locations

### 1. ytdlpWrapper.ts
Main implementation for filename generation during download:

```typescript
function prepareOutputTemplate(template: string, metadata?: VideoMetadata, useSubdirectory: boolean = true): string {
  const sanitizedTemplate = sanitizeOutputTemplate(template);
  
  if (metadata && useSubdirectory) {
    const podcastTitleSlug = create_slug(metadata.uploader || 'unknown');
    const episodeTitleSlug = create_slug(metadata.title || 'untitled');
    return `${podcastTitleSlug}/${episodeTitleSlug}.%(ext)s`;
  }
  
  return sanitizedTemplate;
}
```

### 2. dynamoService.ts
Database storage with slug-based metadata:

```typescript
processEpisodeMetadata(videoMetadata: VideoMetadata, audioS3Link: string): PodcastEpisodeData {
  const podcast_title = create_slug(videoMetadata.uploader || "");
  const episode_title = create_slug(videoMetadata.title || "");
  const file_name = `${podcast_title}/${episode_title}`;
  
  return {
    // ...other fields
    podcast_title,
    episode_title,
    file_name: `${file_name}.mp3`
  };
}
```

### 3. s3KeyUtils.ts
S3 key generation for cloud storage:

```typescript
export function generateAudioS3Key(metadata: VideoMetadata): string {
  const podcastSlug = create_slug(metadata.uploader || 'unknown');
  const episodeSlug = create_slug(metadata.title || 'untitled');
  const timestamp = Date.now();
  
  return `audio/${podcastSlug}/${episodeSlug}_${timestamp}.mp3`;
}
```

## File Sanitization

### Input Sanitization
Before slug generation, inputs are sanitized:

```typescript
function sanitizeFilename(filename: string): string {
  if (!filename) return filename;
  
  // Remove dangerous characters
  let sanitized = filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '_$1')
    .substring(0, 255);
    
  return sanitized || 'untitled';
}
```

### Template Sanitization
yt-dlp output templates are sanitized for filesystem safety:

```typescript
function sanitizeOutputTemplate(template: string): string {
  return template
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/^-+|-+$/g, '');
}
```

## Testing

### Test Scripts Available

```bash
# Test slug filename generation
npm run test:slug-filename

# Test complete slug integration
npm run test:slug-integration

# Test video slug processing
npm run test:video-slug

# Test complete slug functionality
npm run test:complete-slug
```

### Example Test Cases

```typescript
// Test podcast title slugs
create_slug("The Joe Rogan Experience") // → "the-joe-rogan-experience"
create_slug("TED Talks Daily") // → "ted-talks-daily"
create_slug("Café Français") // → "cafe-francais"

// Test episode title slugs
create_slug("#1234 - Elon Musk") // → "1234-elon-musk"
create_slug("How to Build $1M Business") // → "how-to-build-1m-business"
create_slug("AI & the Future of Work") // → "ai-the-future-of-work"
```

## Benefits

### 1. Organization
- Clear podcast/episode hierarchy
- Easy to navigate file structure
- Consistent naming convention

### 2. SEO Optimization
- Search engine friendly URLs
- Descriptive file names
- No special characters or spaces

### 3. Cross-Platform Compatibility
- Works on Windows, macOS, and Linux
- Safe for cloud storage (S3)
- Compatible with web servers

### 4. Maintenance
- Predictable file locations
- Easy automated processing
- Consistent metadata correlation

## Migration Notes

### From Raw Filenames
If migrating from raw YouTube titles, the slug system will:
- Convert existing files to slug format
- Maintain original metadata in DynamoDB
- Create symbolic links for backward compatibility (optional)

### Backward Compatibility
- Original titles preserved in `episode_title_details` field
- Raw metadata stored in DynamoDB
- File mapping available through API endpoints

## Best Practices

### 1. Slug Generation
- Always validate input before slug generation
- Handle empty or null inputs gracefully
- Maintain reasonable length limits (100 characters)

### 2. Directory Management
- Create directories recursively as needed
- Check permissions before file operations
- Clean up temporary files after processing

### 3. Error Handling
- Fallback to 'untitled' for empty slugs
- Log slug generation failures
- Validate generated paths before use

### 4. Performance
- Cache slug generation for repeated titles
- Avoid regenerating slugs for existing content
- Use efficient string operations
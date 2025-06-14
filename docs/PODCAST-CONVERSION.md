# Video-to-Podcast Conversion Feature

This feature automatically converts downloaded videos into podcast episode data, making it easy to manage video content as podcast episodes with rich metadata, topics, and personality analysis.

## Overview

When enabled, the system will automatically:

1. **Download Video & Audio**: Use the existing video pipeline to download content
2. **Extract Metadata**: Capture video metadata (title, description, duration, etc.)
3. **Analyze Content**: Use AI to identify personalities and topics (optional)
4. **Create Podcast Episode**: Convert to podcast episode format with structured data
5. **Store in DynamoDB**: Save episode data for easy querying and management

## Configuration

### Environment Variables

Add these to your `.env` file or use the provided `.env.podcast` template:

```bash
# Enable podcast episode conversion
PODCAST_CONVERSION_ENABLED=true

# DynamoDB table for podcast episodes
DYNAMODB_PODCAST_EPISODES_TABLE=PodcastEpisodeStore

# AI Analysis Configuration
PODCAST_AI_ANALYSIS_ENABLED=true
PODCAST_TOPIC_KEYWORDS=technology,business,science,entertainment,sports,politics,health,interview,discussion
PODCAST_PERSON_KEYWORDS=CEO,founder,expert,professor,doctor,researcher,entrepreneur,host,guest
```

### LocalStack Development

For local development with LocalStack:

```bash
# Copy the podcast environment template
cp .env.podcast .env.localstack.podcast

# Add LocalStack-specific settings
echo "LOCALSTACK=true" >> .env.localstack.podcast
echo "AWS_ENDPOINT_URL=http://localhost:4566" >> .env.localstack.podcast
```

## Usage

### Automatic Conversion

When `PODCAST_CONVERSION_ENABLED=true`, every successful video download will automatically:

1. Create a podcast episode record
2. Analyze content for topics and personalities (if AI analysis enabled)
3. Store the episode in DynamoDB with structured metadata

### Manual Conversion via API

Convert existing completed jobs to podcast episodes:

```bash
curl -X POST http://localhost:3000/api/podcast/convert \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "your-job-id",
    "topicKeywords": ["technology", "interview"],
    "personKeywords": ["CEO", "founder"],
    "enableAiAnalysis": true
  }'
```

### API Endpoints

#### Get All Episodes
```bash
curl http://localhost:3000/api/podcast/episodes?limit=10
```

#### Get Episodes by Podcast Title
```bash
curl "http://localhost:3000/api/podcast/episodes?podcastTitle=Tech%20Talks%20Daily&limit=5"
```

#### Get Specific Episode
```bash
curl http://localhost:3000/api/podcast/episodes/{episode-id}
```

#### Update Transcription Status
```bash
curl -X PUT http://localhost:3000/api/podcast/episodes/{episode-id}/transcription-status \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

## Data Structure

### Podcast Episode Format

```typescript
interface PodcastEpisodeData {
  id: string;                          // Unique episode ID
  episode_title: string;               // URL-friendly title slug
  episode_title_details: string;       // Original full title
  podcast_title: string;               // Channel/uploader name
  description: string;                 // Episode description
  audio_url: string;                   // S3 URL or local path to audio
  transcription_status: string;        // 'new' | 'in_progress' | 'completed' | 'failed'
  image?: string;                      // Thumbnail URL
  published_date: string;              // ISO date string
  source_url?: string;                 // Original video URL
  podcast_author: string;              // Channel/uploader name
  episode_downloaded: boolean;         // Download status
  episode_time_millis?: number;        // Duration in milliseconds
  file_name: string;                   // Storage file name
  personalities: string[];             // Detected personalities/guests
  topics: string[];                    // Extracted topics
  source: string;                      // Source platform (youtube, etc.)
  partial_data: boolean;               // Whether analysis was complete
  number_of_personalities: number;     // Count of personalities
  topic_match: boolean;                // Whether topics matched keywords
  original_video_metadata?: string;    // Full original metadata as JSON
  view_count?: number;                 // Original view count
  like_count?: number;                 // Original like count
  ttl?: number;                        // Auto-cleanup timestamp
}
```

### Content Analysis

The system can analyze video descriptions and titles to extract:

- **Personalities**: Names of people mentioned (interviews, guests, hosts)
- **Topics**: Relevant topics based on provided keywords
- **Matching**: Whether content matches your specified criteria

## Testing & Development

### Run Tests

```bash
# Test basic conversion functionality
npm run test:podcast-conversion

# Demo complete workflow (download + convert)
npm run demo:podcast-workflow

# Test API endpoints
npm run demo:podcast-api

# Query existing data
npm run demo:podcast-query
```

### Development with LocalStack

```bash
# Start LocalStack
npm run localstack:start

# Initialize tables
npm run localstack:init

# Run demo with LocalStack
npm run demo:podcast-workflow

# Stop LocalStack
npm run localstack:stop
```

## Integration Examples

### Python-style Processing

The TypeScript implementation mirrors your Python workflow:

```python
# Your Python code
episode_data = {
    "episode_title": create_slug(episode.get("title")),
    "podcast_title": podcast_title,
    "description": episode.get("description", ""),
    "audio_url": episode.get("enclosures")[0].href,
    "transcription_status": "new",
    # ... more fields
}

analysis = analyze_podcast_summary_cohere(summary, topic_keywords, title)
episode_data["personalities"] = analysis.get("personalities", [])
episode_data["topics"] = analysis["matching_topics"]

insert_episode(episode_data)
```

```typescript
// Equivalent TypeScript implementation
const episodeData: PodcastEpisodeData = {
  episode_title: createSlug(metadata.title),
  podcast_title: metadata.uploader.toLowerCase(),
  description: metadata.description || '',
  audio_url: audioUrl,
  transcription_status: 'new',
  // ... more fields
};

const analysis = await analyzeContent(content, title, config);
episodeData.personalities = analysis.personalities;
episodeData.topics = analysis.matching_topics;

await dynamoService.savePodcastEpisode(episodeData);
```

### Workflow Integration

The podcast conversion integrates seamlessly with your existing video pipeline:

1. **Video Download**: Uses existing yt-dlp wrapper
2. **S3 Upload**: Leverages existing S3 service
3. **Metadata Storage**: Extends existing DynamoDB service
4. **Job Tracking**: Integrates with existing job system

## Advanced Features

### Custom Analysis Configuration

```typescript
const analysisConfig: AnalysisConfig = {
  topic_keywords: ['technology', 'AI', 'business'],
  person_keywords: ['CEO', 'founder', 'expert'],
  enable_ai_analysis: true
};
```

### Batch Processing

Process multiple videos and convert them all to podcast episodes:

```typescript
for (const video of videos) {
  const jobId = uuidv4();
  await processDownload(jobId, video.url);
  // Automatic conversion happens if enabled
}
```

### Query and Management

```typescript
// Get episodes by podcast
const episodes = await dynamoService.getPodcastEpisodesByTitle('Tech Talks Daily');

// Get episodes by transcription status
const newEpisodes = await dynamoService.getEpisodesByTranscriptionStatus('new');

// Update status
await dynamoService.updateTranscriptionStatus(episodeId, 'completed');
```

## Production Considerations

### AWS Bedrock Integration

For production AI analysis, integrate with AWS Bedrock (similar to your Python implementation):

```typescript
// Replace the simple analyzeContent method with Bedrock integration
private async analyzeContent(content: string, title: string): Promise<ContentAnalysisResult> {
  const client = new BedrockRuntimeClient({ region: 'us-east-1' });
  // ... implement Bedrock API calls similar to your Python code
}
```

### Performance Optimization

- Use DynamoDB batch operations for bulk processing
- Implement caching for repeated analysis
- Use SQS for asynchronous podcast conversion
- Set up TTL for automatic cleanup of old episodes

### Monitoring

- Track conversion success rates
- Monitor AI analysis costs
- Set up CloudWatch alarms for failed conversions
- Log analytics for topic and personality extraction accuracy

## Troubleshooting

### Common Issues

1. **Missing Audio URL**: Ensure S3 upload is enabled and successful
2. **Analysis Failures**: Check AI analysis configuration and API limits
3. **DynamoDB Errors**: Verify table names and AWS credentials
4. **Missing Episodes**: Check if conversion is enabled and job completed successfully

### Debug Commands

```bash
# Check health status
curl http://localhost:3000/health

# View logs
docker logs video_pipeline_container

# Query DynamoDB directly
aws dynamodb scan --table-name PodcastEpisodeStore --endpoint-url http://localhost:4566
```

This feature transforms your video pipeline into a comprehensive podcast content management system, making it easy to organize, search, and manage video content as structured podcast episodes.

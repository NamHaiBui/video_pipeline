# Video Trimming Queue Configuration Deployment Checklist

## Environment Variable Setup

### 1. Local Development (.env)
```bash
# Add to your .env file:
VIDEO_TRIMMING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming

# For LocalStack development:
VIDEO_TRIMMING_QUEUE_URL=http://localhost:4566/000000000000/test-video-trimming
```

### 2. Docker Compose
✅ **Completed**: All docker-compose files updated with `VIDEO_TRIMMING_QUEUE_URL`
- `docker-compose.yml` - Main configuration
- `docker-compose.prod.yml` - Production configuration  
- `docker-compose.local.yml` - Local development with LocalStack

### 3. AWS ECS Deployment
✅ **Completed**: ECS task definition updated to include:
```json
{
  "name": "VIDEO_TRIMMING_QUEUE_URL",
  "valueFrom": "arn:aws:ssm:{{AWS_REGION}}:{{ACCOUNT_ID}}:parameter/video-pipeline/video-trimming-queue-url"
}
```

### 4. AWS Systems Manager Parameter Store
✅ **Completed**: Setup script updated to create parameter:
```bash
aws ssm put-parameter \
    --name "/video-pipeline/video-trimming-queue-url" \
    --value "https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming" \
    --type "String" \
    --overwrite
```

## Deployment Steps

### For New Deployments:
1. Run infrastructure setup script to create SSM parameters:
   ```bash
   ./setup-aws-infrastructure.sh
   ```

2. Deploy with Docker Compose:
   ```bash
   # Local development
   docker-compose -f docker-compose.local.yml up -d
   
   # Production
   docker-compose -f docker-compose.prod.yml up -d
   ```

3. Or deploy to ECS using the updated task definition

### For Existing Deployments:
1. Add the SSM parameter manually:
   ```bash
   aws ssm put-parameter \
       --name "/video-pipeline/video-trimming-queue-url" \
       --value "https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming" \
       --type "String"
   ```

2. Update your ECS service with the new task definition

3. Or restart your Docker containers to pick up environment variable changes

## Testing

Test the functionality using:
```bash
npm run test:trimming-queue <episode-id>
```

## Configuration Override

The system will use the environment variable `VIDEO_TRIMMING_QUEUE_URL` if set, otherwise falls back to the default queue URL.

## Security Notes

- The video trimming queue URL is stored in AWS Systems Manager Parameter Store for ECS deployments
- For local development, the URL can be set in environment variables
- Consider using IAM policies to restrict access to the video trimming queue

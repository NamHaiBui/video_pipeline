#!/bin/bash

# Create sample job script for SQS integration
# This script sends a sample job message to the SQS queue for the specified YouTube URL

# Load environment variables
if [ -f .env ]; then
  source .env
fi

# Set default values if not set in environment
REGION=${AWS_REGION:-us-east-1}
QUEUE_URL=${SQS_QUEUE_URL}

# Check if SQS queue URL is configured
if [ -z "$QUEUE_URL" ]; then
  echo "❌ SQS_QUEUE_URL is not set. Please configure your environment variables."
  echo "   Set SQS_QUEUE_URL in your .env file or environment"
  exit 1
fi

echo "✅ Using SQS queue: $QUEUE_URL"

# Verify AWS credentials
echo "🔍 Checking AWS credentials..."
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "❌ AWS credentials not configured. Please run 'aws configure' or set AWS environment variables."
  exit 1
fi

echo "✅ AWS credentials configured"

# Generate a UUID for the job ID
JOB_ID=$(uuidgen)
if [ -z "$JOB_ID" ]; then
  echo "❌ Failed to generate UUID. Using timestamp instead."
  JOB_ID="sample-job-$(date +%s)"
fi

# Create the sample job message for the specified YouTube URL
echo "📤 Creating sample job message with job ID: $JOB_ID"
VIDEO_URL="https://www.youtube.com/watch?v=HUkBz-cdB-k"

# Create a comprehensive job message with options
MESSAGE=$(cat <<EOF
{
  "jobId": "${JOB_ID}",
  "url": "${VIDEO_URL}",
  "options": {
    "format": "best",
    "quality": "720p",
    "extractAudio": true,
    "priority": "normal"
  },
  "metadata": {
    "source": "manual",
    "requestedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "requestedBy": "sample-script"
  }
}
EOF
)

# Send the message to SQS
echo "📤 Sending sample job message to queue..."
aws sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body "$MESSAGE" \
  --region $REGION

if [ $? -eq 0 ]; then
  echo "✅ Sample job message sent successfully to queue: $QUEUE_URL"
  echo ""
  echo "📝 Message payload:"
  echo "$MESSAGE" | jq . 2>/dev/null || echo "$MESSAGE"
  echo ""
  echo "🎬 Video URL: $VIDEO_URL"
  echo "🆔 Job ID: $JOB_ID"
  echo ""
  echo "🚀 You can now run the SQS poller to process this message:"
  echo "   npm run sqs-poller"
  echo ""
  echo "📊 To check queue status:"
  echo "   aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names All --region $REGION"
  echo ""
  echo "📋 To receive messages from queue:"
  echo "   aws sqs receive-message --queue-url $QUEUE_URL --region $REGION"
else
  echo "❌ Failed to send message to queue"
  exit 1
fi

#!/bin/bash

# Test script for SQS integration with LocalStack
# This script sends test messages to the SQS queue for processing

# Load environment variables
if [ -f .env.localstack ]; then
  source .env.localstack
fi

# Set default values if not set in environment
AWS_ENDPOINT=${LOCALSTACK_ENDPOINT:-http://localhost:4566}
REGION=${AWS_REGION:-us-east-1}
QUEUE_NAME=${SQS_QUEUE_NAME:-video-pipeline-jobs}

# Check if localstack is running
echo "🔍 Checking LocalStack status..."
if ! curl -s $AWS_ENDPOINT/_localstack/health | grep -q '"sqs": "available"'; then
  echo "❌ LocalStack SQS service is not available. Make sure LocalStack is running."
  echo "   Run: docker compose -f docker-compose.localstack.yml up -d"
  exit 1
fi

echo "✅ LocalStack SQS service is available"

# Get queue URL
echo "🔍 Getting queue URL for $QUEUE_NAME..."
QUEUE_URL=$(awslocal sqs get-queue-url --queue-name $QUEUE_NAME --query 'QueueUrl' --output text 2>/dev/null)

if [ -z "$QUEUE_URL" ]; then
  echo "❌ Queue '$QUEUE_NAME' not found. Creating it..."
  awslocal sqs create-queue --queue-name $QUEUE_NAME --region $REGION
  QUEUE_URL=$(awslocal sqs get-queue-url --queue-name $QUEUE_NAME --query 'QueueUrl' --output text)
  echo "✅ Queue created: $QUEUE_URL"
else
  echo "✅ Queue found: $QUEUE_URL"
fi

# Generate a UUID for the job ID
JOB_ID=$(uuidgen)
if [ -z "$JOB_ID" ]; then
  echo "❌ Failed to generate UUID. Using timestamp instead."
  JOB_ID="test-$(date +%s)"
fi

# Send a test message
echo "📤 Sending test message to queue with job ID: $JOB_ID"
VIDEO_URL="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
MESSAGE="{\"jobId\":\"${JOB_ID}\",\"url\":\"${VIDEO_URL}\"}"

awslocal sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body "$MESSAGE" \
  --region $REGION

echo "✅ Test message sent to queue: $QUEUE_URL"
echo "📝 Message payload:"
echo "$MESSAGE" | jq . 2>/dev/null || echo "$MESSAGE"

echo ""
echo "🚀 You can now run the worker to process this message:"
echo "   npx ts-node-esm src/worker.ts"
echo ""
echo "📊 To check the CloudWatch logs, run:"
echo "   awslocal logs describe-log-groups"
echo "   awslocal logs describe-log-streams --log-group-name video-pipeline-logs"
echo ""
echo "📝 To view log entries, run:"
echo "   awslocal logs get-log-events --log-group-name video-pipeline-logs --log-stream-name [STREAM_NAME]"

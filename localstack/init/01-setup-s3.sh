#!/bin/bash

# LocalStack S3 and DynamoDB initialization script
# This script runs when LocalStack starts up

echo "🚀 Initializing LocalStack services for video pipeline..."

# Wait for LocalStack to be ready
echo "⏳ Waiting for LocalStack S3 to be ready..."
until curl -s http://localhost:4566/_localstack/health | grep -q -E '"s3": "(available|running)"'; do
  echo "   S3 not ready yet, waiting..."
  sleep 2
done

echo "⏳ Waiting for LocalStack DynamoDB to be ready..."
until curl -s http://localhost:4566/_localstack/health | grep -q -E '"dynamodb": "(available|running)"'; do
  echo "   DynamoDB not ready yet, waiting..."
  sleep 2
done

echo "⏳ Waiting for LocalStack SQS to be ready..."
until curl -s http://localhost:4566/_localstack/health | grep -q -E '"sqs": "(available|running)"'; do
  echo "   SQS not ready yet, waiting..."
  sleep 2
done

echo "✅ LocalStack services are ready, creating resources..."

# Create S3 buckets using awslocal (LocalStack's AWS CLI wrapper)
echo "📦 Creating S3 buckets..."
awslocal s3 mb s3://pd-audio-storage --region us-east-1
awslocal s3 mb s3://pd-video-storage --region us-east-1

# Set bucket policies for testing (make them publicly readable for testing)
echo "📋 Setting up S3 bucket policies..."

# Create a basic bucket policy for the audio bucket
cat > /tmp/pd-audio-storage-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::pd-audio-storage/*"
    }
  ]
}
EOF

# Create a basic bucket policy for the video bucket
cat > /tmp/pd-video-storage-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::pd-video-storage/*"
    }
  ]
}
EOF

# Apply bucket policies
awslocal s3api put-bucket-policy --bucket pd-audio-storage --policy file:///tmp/pd-audio-storage-policy.json
awslocal s3api put-bucket-policy --bucket pd-video-storage --policy file:///tmp/pd-video-storage-policy.json

# Enable versioning on buckets
awslocal s3api put-bucket-versioning --bucket pd-audio-storage --versioning-configuration Status=Enabled
awslocal s3api put-bucket-versioning --bucket pd-video-storage --versioning-configuration Status=Enabled

# Create DynamoDB tables
echo "📊 Creating DynamoDB tables..."

# Video metadata table with upload date index
awslocal dynamodb create-table \
  --table-name video-pipeline-metadata \
  --attribute-definitions \
    AttributeName=videoId,AttributeType=S \
    AttributeName=uploadDate,AttributeType=S \
  --key-schema \
    AttributeName=videoId,KeyType=HASH \
  --global-secondary-indexes \
    IndexName=UploadDateIndex,KeySchema='[{AttributeName=uploadDate,KeyType=HASH}]',Projection='{ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

# Download jobs table with status index
awslocal dynamodb create-table \
  --table-name video-pipeline-jobs \
  --attribute-definitions \
    AttributeName=jobId,AttributeType=S \
    AttributeName=status,AttributeType=S \
    AttributeName=createdAt,AttributeType=S \
  --key-schema \
    AttributeName=jobId,KeyType=HASH \
  --global-secondary-indexes \
    IndexName=StatusIndex,KeySchema='[{AttributeName=status,KeyType=HASH},{AttributeName=createdAt,KeyType=RANGE}]',Projection='{ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

# Podcast episodes table for podcast conversion feature
awslocal dynamodb create-table \
  --table-name PodcastEpisodeStore \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
    AttributeName=podcast_title,AttributeType=S \
    AttributeName=published_date,AttributeType=S \
    AttributeName=transcription_status,AttributeType=S \
  --key-schema \
    AttributeName=id,KeyType=HASH \
  --global-secondary-indexes \
    IndexName=PodcastTitleIndex,KeySchema='[{AttributeName=podcast_title,KeyType=HASH},{AttributeName=published_date,KeyType=RANGE}]',Projection='{ProjectionType=ALL}' \
    IndexName=TranscriptionStatusIndex,KeySchema='[{AttributeName=transcription_status,KeyType=HASH},{AttributeName=published_date,KeyType=RANGE}]',Projection='{ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

# Create CloudWatch Log Groups
echo "📊 Creating CloudWatch log groups..."
awslocal logs create-log-group --log-group-name video-pipeline-logs --region us-east-1
awslocal logs create-log-group --log-group-name video-pipeline-app-logs --region us-east-1

# Create SQS Queue
echo "📬 Creating SQS queue..."
awslocal sqs create-queue --queue-name video-pipeline-jobs --region us-east-1

# Create a dead letter queue for failed job processing
awslocal sqs create-queue --queue-name video-pipeline-jobs-dlq --region us-east-1

# Get queue URLs and ARNs for setting up the DLQ
MAIN_QUEUE_URL=$(awslocal sqs get-queue-url --queue-name video-pipeline-jobs --query 'QueueUrl' --output text --region us-east-1)
DLQ_QUEUE_URL=$(awslocal sqs get-queue-url --queue-name video-pipeline-jobs-dlq --query 'QueueUrl' --output text --region us-east-1)
DLQ_QUEUE_ARN=$(awslocal sqs get-queue-attributes --queue-url $DLQ_QUEUE_URL --attribute-names QueueArn --query 'Attributes.QueueArn' --output text --region us-east-1)

# Set up redrive policy to use the DLQ after 5 failed attempts
awslocal sqs set-queue-attributes \
  --queue-url $MAIN_QUEUE_URL \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_QUEUE_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" \
  --region us-east-1

echo "✅ LocalStack initialization complete!"
echo "📦 Created S3 buckets:"
echo "   - pd-audio-storage (audio files and metadata)"
echo "   - pd-video-storage (video files)"
echo "📊 Created DynamoDB tables:"
echo "   - video-pipeline-metadata"
echo "   - video-pipeline-jobs"
echo "   - PodcastEpisodeStore"
echo "📊 Created CloudWatch log groups:"
echo "   - video-pipeline-logs"
echo "   - video-pipeline-app-logs"
echo "📬 Created SQS queues:"
echo "   - video-pipeline-jobs"
echo "   - video-pipeline-jobs-dlq"
echo ""
echo "🌐 LocalStack Web UI: http://localhost:8080"
echo "🔗 LocalStack Endpoint: http://localhost:4566"
echo ""
echo "🧪 Test S3 connectivity:"
echo "   awslocal s3 ls"
echo "🧪 Test DynamoDB connectivity:"
echo "   awslocal dynamodb list-tables"
echo "🧪 General health check:"
echo "   curl http://localhost:4566/_localstack/health"

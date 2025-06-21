#!/bin/bash

# AWS Resource Setup Script for Video Pipeline
# This script creates all necessary AWS resources (S3 buckets, DynamoDB tables, SQS queues)
# for the video pipeline application to function properly.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment variables from .env file if it exists
if [[ -f .env ]]; then
    echo -e "${BLUE}📄 Loading environment variables from .env file...${NC}"
    set -a
    source .env
    set +a
fi

# Default values for AWS resources
AWS_REGION=${AWS_REGION:-us-east-1}
S3_AUDIO_BUCKET=${S3_AUDIO_BUCKET:-pd-audio-storage-test}
S3_VIDEO_BUCKET=${S3_VIDEO_BUCKET:-pd-video-storage-test}
DYNAMODB_PODCAST_EPISODES_TABLE=${DYNAMODB_PODCAST_EPISODES_TABLE:-PodcastEpisodeStoreTest}

echo -e "${BLUE}☁️  Using AWS cloud services${NC}"
AWS_CMD="aws"

echo -e "${BLUE}🚀 Setting up AWS resources for Video Pipeline...${NC}"
echo -e "${BLUE}Region: $AWS_REGION${NC}"

# Function to check if S3 bucket exists
check_s3_bucket() {
    local bucket_name=$1
    if $AWS_CMD s3api head-bucket --bucket "$bucket_name" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Function to create S3 bucket
create_s3_bucket() {
    local bucket_name=$1
    local description=$2
    
    echo -e "${YELLOW}📦 Creating S3 bucket: $bucket_name${NC}"
    
    if [[ "$AWS_REGION" == "us-east-1" ]]; then
        $AWS_CMD s3api create-bucket --bucket "$bucket_name"
    else
        $AWS_CMD s3api create-bucket --bucket "$bucket_name" --region "$AWS_REGION" --create-bucket-configuration LocationConstraint="$AWS_REGION"
    fi
    
    # Set bucket versioning (optional but recommended)
    $AWS_CMD s3api put-bucket-versioning --bucket "$bucket_name" --versioning-configuration Status=Enabled
    
    # Set bucket CORS for web access (if needed)
    cat > /tmp/cors-config.json << EOF
{
    "CORSRules": [
        {
            "AllowedHeaders": ["*"],
            "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
            "AllowedOrigins": ["*"],
            "ExposeHeaders": ["ETag"],
            "MaxAgeSeconds": 3000
        }
    ]
}
EOF
    
    $AWS_CMD s3api put-bucket-cors --bucket "$bucket_name" --cors-configuration file:///tmp/cors-config.json
    rm -f /tmp/cors-config.json
    
    echo -e "${GREEN}✅ Created S3 bucket: $bucket_name ($description)${NC}"
}

# Function to check if DynamoDB table exists
check_dynamodb_table() {
    local table_name=$1
    if $AWS_CMD dynamodb describe-table --table-name "$table_name" >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to create DynamoDB table for podcast episodes
create_podcast_episodes_table() {
    local table_name=$1
    
    echo -e "${YELLOW}🗃️  Creating DynamoDB table: $table_name${NC}"
    
    $AWS_CMD dynamodb create-table \
        --table-name "$table_name" \
        --attribute-definitions \
            AttributeName=episodeId,AttributeType=S \
            AttributeName=podcastSlug,AttributeType=S \
        --key-schema \
            AttributeName=episodeId,KeyType=HASH \
        --global-secondary-indexes \
            IndexName=PodcastSlugIndex,KeySchema='[{AttributeName=podcastSlug,KeyType=HASH}]',Projection='{ProjectionType=ALL}' \
        --billing-mode PAY_PER_REQUEST \
        --region "$AWS_REGION"
    
    echo -e "${BLUE}⏳ Waiting for table to become active...${NC}"
    $AWS_CMD dynamodb wait table-exists --table-name "$table_name" --region "$AWS_REGION"
    
    echo -e "${GREEN}✅ Created DynamoDB table: $table_name${NC}"
}

# Main setup process
echo -e "${BLUE}🔍 Checking existing AWS resources...${NC}"

# Setup S3 Buckets
echo -e "\n${BLUE}📦 Setting up S3 buckets...${NC}"

if check_s3_bucket "$S3_AUDIO_BUCKET"; then
    echo -e "${GREEN}✅ S3 bucket already exists: $S3_AUDIO_BUCKET${NC}"
else
    create_s3_bucket "$S3_AUDIO_BUCKET" "Audio storage for podcast episodes"
fi

if check_s3_bucket "$S3_VIDEO_BUCKET"; then
    echo -e "${GREEN}✅ S3 bucket already exists: $S3_VIDEO_BUCKET${NC}"
else
    create_s3_bucket "$S3_VIDEO_BUCKET" "Video storage for podcast episodes"
fi

# Setup DynamoDB Tables
echo -e "\n${BLUE}🗃️  Setting up DynamoDB tables...${NC}"

if check_dynamodb_table "$DYNAMODB_PODCAST_EPISODES_TABLE"; then
    echo -e "${GREEN}✅ DynamoDB table already exists: $DYNAMODB_PODCAST_EPISODES_TABLE${NC}"
else
    create_podcast_episodes_table "$DYNAMODB_PODCAST_EPISODES_TABLE"
fi

echo -e "\n${GREEN}🎉 AWS resource setup completed successfully!${NC}"
echo -e "\n${BLUE}📋 Summary of created/verified resources:${NC}"
echo -e "   S3 Audio Bucket: $S3_AUDIO_BUCKET"
echo -e "   S3 Video Bucket: $S3_VIDEO_BUCKET"
echo -e "   DynamoDB Podcast Episodes Table: $DYNAMODB_PODCAST_EPISODES_TABLE"

echo -e "\n${YELLOW}💡 Next steps:${NC}"
echo -e "   1. Make sure your AWS credentials are configured"
echo -e "   2. Update your .env file with the resource names if needed"
echo -e "   3. Run your application: npm start"

#!/bin/bash

# AWS Infrastructure Setup Script for Video Pipeline ECS Deployment
# This script creates the necessary AWS infrastructure for deploying the video pipeline

set -e

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
PROJECT_NAME=${PROJECT_NAME:-video-pipeline}
ECR_REPOSITORY_NAME=${ECR_REPOSITORY_NAME:-video-pipeline}
ECS_CLUSTER_NAME=${ECS_CLUSTER_NAME:-video-pipeline-cluster}
EFS_FILE_SYSTEM_NAME=${EFS_FILE_SYSTEM_NAME:-video-pipeline-efs}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Get AWS account ID
get_account_id() {
    aws sts get-caller-identity --query Account --output text
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    if ! command -v aws &> /dev/null; then
        error "AWS CLI is not installed. Please install it first."
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured. Run 'aws configure' first."
    fi
    
    log "Prerequisites check passed ✓"
}

# Create S3 buckets
create_s3_buckets() {
    log "Creating S3 buckets..."
    
    local audio_bucket="${PROJECT_NAME}-audio-$(date +%s)"
    local video_bucket="${PROJECT_NAME}-video-$(date +%s)"
    local metadata_bucket="${PROJECT_NAME}-metadata-$(date +%s)"
    
    # Create buckets
    aws s3 mb "s3://$audio_bucket" --region "$AWS_REGION" || warn "Audio bucket may already exist"
    aws s3 mb "s3://$video_bucket" --region "$AWS_REGION" || warn "Video bucket may already exist"
    aws s3 mb "s3://$metadata_bucket" --region "$AWS_REGION" || warn "Metadata bucket may already exist"
    
    # Enable versioning
    aws s3api put-bucket-versioning --bucket "$audio_bucket" --versioning-configuration Status=Enabled
    aws s3api put-bucket-versioning --bucket "$video_bucket" --versioning-configuration Status=Enabled
    aws s3api put-bucket-versioning --bucket "$metadata_bucket" --versioning-configuration Status=Enabled
    
    log "S3 buckets created ✓"
    echo "Audio bucket: $audio_bucket"
    echo "Video bucket: $video_bucket"
    echo "Metadata bucket: $metadata_bucket"
    
    # Store bucket names for later use
    echo "$audio_bucket" > .aws-audio-bucket
    echo "$video_bucket" > .aws-video-bucket
    echo "$metadata_bucket" > .aws-metadata-bucket
}

# Create DynamoDB tables
create_dynamodb_tables() {
    log "Creating DynamoDB tables..."
    
    # Podcast episodes table
    aws dynamodb create-table \
        --table-name "${PROJECT_NAME}-episodes" \
        --attribute-definitions \
            AttributeName=id,AttributeType=S \
            AttributeName=podcast_title,AttributeType=S \
            AttributeName=published_date,AttributeType=S \
        --key-schema \
            AttributeName=id,KeyType=HASH \
        --global-secondary-indexes \
            IndexName=PodcastTitleIndex,KeySchema='[{AttributeName=podcast_title,KeyType=HASH},{AttributeName=published_date,KeyType=RANGE}]',Projection='{ProjectionType=ALL}',ProvisionedThroughput='{ReadCapacityUnits=5,WriteCapacityUnits=5}' \
        --provisioned-throughput \
            ReadCapacityUnits=5,WriteCapacityUnits=5 \
        --region "$AWS_REGION" || warn "Episodes table may already exist"
    
    # Metadata table
    aws dynamodb create-table \
        --table-name "${PROJECT_NAME}-metadata" \
        --attribute-definitions \
            AttributeName=videoId,AttributeType=S \
            AttributeName=uploadDate,AttributeType=S \
        --key-schema \
            AttributeName=videoId,KeyType=HASH \
        --global-secondary-indexes \
            IndexName=UploadDateIndex,KeySchema='[{AttributeName=uploadDate,KeyType=HASH}]',Projection='{ProjectionType=ALL}',ProvisionedThroughput='{ReadCapacityUnits=5,WriteCapacityUnits=5}' \
        --provisioned-throughput \
            ReadCapacityUnits=5,WriteCapacityUnits=5 \
        --region "$AWS_REGION" || warn "Metadata table may already exist"
    
    log "DynamoDB tables created ✓"
    echo "Episodes table: ${PROJECT_NAME}-episodes"
    echo "Metadata table: ${PROJECT_NAME}-metadata"
}

# Create SQS queue
create_sqs_queue() {
    log "Creating SQS queue..."
    
    # Main queue
    local queue_url=$(aws sqs create-queue \
        --queue-name "${PROJECT_NAME}-jobs" \
        --attributes VisibilityTimeoutSeconds=300,MessageRetentionPeriod=1209600 \
        --region "$AWS_REGION" \
        --query 'QueueUrl' \
        --output text)
    
    # Dead letter queue
    local dlq_url=$(aws sqs create-queue \
        --queue-name "${PROJECT_NAME}-jobs-dlq" \
        --region "$AWS_REGION" \
        --query 'QueueUrl' \
        --output text)
    
    log "SQS queues created ✓"
    echo "Main queue: $queue_url"
    echo "Dead letter queue: $dlq_url"
    
    # Store queue URL for later use
    echo "$queue_url" > .aws-queue-url
}

# Create ECS cluster
create_ecs_cluster() {
    log "Creating ECS cluster..."
    
    aws ecs create-cluster \
        --cluster-name "$ECS_CLUSTER_NAME" \
        --capacity-providers FARGATE \
        --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
        --region "$AWS_REGION" || warn "ECS cluster may already exist"
    
    log "ECS cluster created ✓"
    echo "Cluster name: $ECS_CLUSTER_NAME"
}

# Create ECR repository
create_ecr_repository() {
    log "Creating ECR repository..."
    
    aws ecr create-repository \
        --repository-name "$ECR_REPOSITORY_NAME" \
        --image-scanning-configuration scanOnPush=true \
        --region "$AWS_REGION" || warn "ECR repository may already exist"
    
    log "ECR repository created ✓"
    echo "Repository name: $ECR_REPOSITORY_NAME"
}

# Create EFS file system
create_efs() {
    log "Creating EFS file system..."
    
    local file_system_id=$(aws efs create-file-system \
        --creation-token "${PROJECT_NAME}-$(date +%s)" \
        --performance-mode generalPurpose \
        --throughput-mode provisioned \
        --provisioned-throughput-in-mibps 100 \
        --encrypted \
        --tags Key=Name,Value="$EFS_FILE_SYSTEM_NAME" \
        --region "$AWS_REGION" \
        --query 'FileSystemId' \
        --output text)
    
    log "EFS file system created ✓"
    echo "File system ID: $file_system_id"
    
    # Store EFS ID for later use
    echo "$file_system_id" > .aws-efs-id
}

# Create CloudWatch log group
create_cloudwatch_logs() {
    log "Creating CloudWatch log group..."
    
    aws logs create-log-group \
        --log-group-name "/ecs/$PROJECT_NAME" \
        --region "$AWS_REGION" || warn "Log group may already exist"
    
    log "CloudWatch log group created ✓"
    echo "Log group: /ecs/$PROJECT_NAME"
}

# Store configuration in SSM Parameter Store
store_configuration() {
    log "Storing configuration in SSM Parameter Store..."
    
    local audio_bucket=$(cat .aws-audio-bucket 2>/dev/null || echo "")
    local video_bucket=$(cat .aws-video-bucket 2>/dev/null || echo "")
    local metadata_bucket=$(cat .aws-metadata-bucket 2>/dev/null || echo "")
    local queue_url=$(cat .aws-queue-url 2>/dev/null || echo "")
    local efs_id=$(cat .aws-efs-id 2>/dev/null || echo "")
    
    # Store parameters
    if [ -n "$audio_bucket" ]; then
        aws ssm put-parameter \
            --name "/$PROJECT_NAME/s3-audio-bucket" \
            --value "$audio_bucket" \
            --type "String" \
            --overwrite \
            --region "$AWS_REGION"
    fi
    
    if [ -n "$video_bucket" ]; then
        aws ssm put-parameter \
            --name "/$PROJECT_NAME/s3-video-bucket" \
            --value "$video_bucket" \
            --type "String" \
            --overwrite \
            --region "$AWS_REGION"
    fi
    
    if [ -n "$metadata_bucket" ]; then
        aws ssm put-parameter \
            --name "/$PROJECT_NAME/s3-metadata-bucket" \
            --value "$metadata_bucket" \
            --type "String" \
            --overwrite \
            --region "$AWS_REGION"
    fi
    
    if [ -n "$queue_url" ]; then
        aws ssm put-parameter \
            --name "/$PROJECT_NAME/sqs-queue-url" \
            --value "$queue_url" \
            --type "String" \
            --overwrite \
            --region "$AWS_REGION"
    fi
    
    # Store video trimming queue URL parameter
    aws ssm put-parameter \
        --name "/$PROJECT_NAME/video-trimming-queue-url" \
        --value "https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming" \
        --type "String" \
        --overwrite \
        --region "$AWS_REGION"
    
    aws ssm put-parameter \
        --name "/$PROJECT_NAME/dynamodb-episodes-table" \
        --value "${PROJECT_NAME}-episodes" \
        --type "String" \
        --overwrite \
        --region "$AWS_REGION"
    
    aws ssm put-parameter \
        --name "/$PROJECT_NAME/dynamodb-metadata-table" \
        --value "${PROJECT_NAME}-metadata" \
        --type "String" \
        --overwrite \
        --region "$AWS_REGION"
    
    if [ -n "$efs_id" ]; then
        aws ssm put-parameter \
            --name "/$PROJECT_NAME/efs-file-system-id" \
            --value "$efs_id" \
            --type "String" \
            --overwrite \
            --region "$AWS_REGION"
    fi
    
    log "Configuration stored in SSM Parameter Store ✓"
}

# Generate environment file
generate_env_file() {
    log "Generating .env.aws file..."
    
    local audio_bucket=$(cat .aws-audio-bucket 2>/dev/null || echo "")
    local video_bucket=$(cat .aws-video-bucket 2>/dev/null || echo "")
    local metadata_bucket=$(cat .aws-metadata-bucket 2>/dev/null || echo "")
    local queue_url=$(cat .aws-queue-url 2>/dev/null || echo "")
    
    cat > .env.aws << EOF
# Generated AWS Environment Configuration
# Copy values to your production environment

AWS_REGION=$AWS_REGION
S3_AUDIO_BUCKET_NAME=$audio_bucket
S3_VIDEO_BUCKET_NAME=$video_bucket
S3_METADATA_BUCKET_NAME=$metadata_bucket
SQS_QUEUE_URL=$queue_url
DYNAMODB_PODCAST_EPISODES_TABLE=${PROJECT_NAME}-episodes
DYNAMODB_METADATA_TABLE=${PROJECT_NAME}-metadata

# ECS Configuration
ECS_CLUSTER_NAME=$ECS_CLUSTER_NAME
ECR_REPOSITORY_NAME=$ECR_REPOSITORY_NAME

# Set these manually:
# AWS_ACCESS_KEY_ID=your_access_key
# AWS_SECRET_ACCESS_KEY=your_secret_key
# YOUTUBE_API_KEY=your_youtube_api_key
EOF
    
    log ".env.aws file generated ✓"
}

# Cleanup temporary files
cleanup_temp_files() {
    rm -f .aws-audio-bucket .aws-video-bucket .aws-metadata-bucket .aws-queue-url .aws-efs-id
}

# Main setup function
main() {
    log "🚀 Starting AWS infrastructure setup for Video Pipeline"
    log "Region: $AWS_REGION"
    log "Project: $PROJECT_NAME"
    
    check_prerequisites
    create_s3_buckets
    create_dynamodb_tables
    create_sqs_queue
    create_ecs_cluster
    create_ecr_repository
    create_efs
    create_cloudwatch_logs
    store_configuration
    generate_env_file
    cleanup_temp_files
    
    log "🎉 AWS infrastructure setup completed!"
    log ""
    log "Next steps:"
    log "1. Review the generated .env.aws file"
    log "2. Set your AWS credentials and API keys manually"
    log "3. Run ./deploy-ecs.sh to deploy the application"
    log ""
    log "📝 Note: EFS mount targets and security groups may need to be configured manually"
    log "    based on your VPC setup."
}

# Handle script arguments
case "${1:-setup}" in
    "setup")
        main
        ;;
    "s3-only")
        check_prerequisites
        create_s3_buckets
        ;;
    "dynamodb-only")
        check_prerequisites
        create_dynamodb_tables
        ;;
    "help")
        echo "Usage: $0 [setup|s3-only|dynamodb-only|help]"
        echo "  setup        - Complete infrastructure setup (default)"
        echo "  s3-only      - Create only S3 buckets"
        echo "  dynamodb-only - Create only DynamoDB tables"
        echo "  help         - Show this help"
        ;;
    *)
        error "Unknown command: $1. Use 'help' for usage information."
        ;;
esac

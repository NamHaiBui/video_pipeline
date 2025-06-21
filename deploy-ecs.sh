#!/bin/bash

# AWS ECS Deployment Script for Video Pipeline
# This script deploys the containerized video pipeline to AWS ECS

set -e

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
ECR_REPOSITORY_NAME=${ECR_REPOSITORY_NAME:-video-pipeline}
ECS_CLUSTER_NAME=${ECS_CLUSTER_NAME:-video-pipeline-cluster}
ECS_SERVICE_NAME=${ECS_SERVICE_NAME:-video-pipeline-service}
ECS_TASK_DEFINITION_NAME=${ECS_TASK_DEFINITION_NAME:-video-pipeline-task}
IMAGE_TAG=${IMAGE_TAG:-latest}

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

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    if ! command -v aws &> /dev/null; then
        error "AWS CLI is not installed. Please install it first."
    fi
    
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Please install it first."
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        error "AWS credentials not configured. Run 'aws configure' first."
    fi
    
    log "Prerequisites check passed ✓"
}

# Get AWS account ID
get_account_id() {
    aws sts get-caller-identity --query Account --output text
}

# Create ECR repository if it doesn't exist
create_ecr_repository() {
    log "Checking ECR repository..."
    
    if ! aws ecr describe-repositories --repository-names "$ECR_REPOSITORY_NAME" --region "$AWS_REGION" &> /dev/null; then
        log "Creating ECR repository: $ECR_REPOSITORY_NAME"
        aws ecr create-repository \
            --repository-name "$ECR_REPOSITORY_NAME" \
            --region "$AWS_REGION" \
            --image-scanning-configuration scanOnPush=true
    else
        log "ECR repository $ECR_REPOSITORY_NAME already exists ✓"
    fi
}

# Build and push Docker image
build_and_push_image() {
    local account_id=$(get_account_id)
    local ecr_uri="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY_NAME}:${IMAGE_TAG}"
    
    log "Building Docker image..."
    docker build -f Dockerfile.production -t "$ECR_REPOSITORY_NAME:$IMAGE_TAG" .
    
    log "Tagging image for ECR..."
    docker tag "$ECR_REPOSITORY_NAME:$IMAGE_TAG" "$ecr_uri"
    
    log "Logging into ECR..."
    aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
    
    log "Pushing image to ECR..."
    docker push "$ecr_uri"
    
    log "Image pushed successfully: $ecr_uri ✓"
    echo "$ecr_uri"
}

# Update ECS task definition
update_task_definition() {
    local image_uri=$1
    local account_id=$(get_account_id)
    
    log "Updating ECS task definition..."
    
    # Read the task definition template and replace placeholders
    local task_def=$(cat ecs-task-definition.json | \
        sed "s|{{IMAGE_URI}}|$image_uri|g" | \
        sed "s|{{AWS_REGION}}|$AWS_REGION|g" | \
        sed "s|{{ACCOUNT_ID}}|$account_id|g")
    
    # Register new task definition
    local new_task_def_arn=$(echo "$task_def" | aws ecs register-task-definition \
        --cli-input-json file:///dev/stdin \
        --query 'taskDefinition.taskDefinitionArn' \
        --output text)
    
    log "New task definition registered: $new_task_def_arn ✓"
    echo "$new_task_def_arn"
}

# Update ECS service
update_service() {
    local task_def_arn=$1
    
    log "Updating ECS service..."
    
    aws ecs update-service \
        --cluster "$ECS_CLUSTER_NAME" \
        --service "$ECS_SERVICE_NAME" \
        --task-definition "$task_def_arn" \
        --force-new-deployment \
        --region "$AWS_REGION" > /dev/null
    
    log "ECS service update initiated ✓"
}

# Wait for service to stabilize
wait_for_deployment() {
    log "Waiting for service to stabilize..."
    
    aws ecs wait services-stable \
        --cluster "$ECS_CLUSTER_NAME" \
        --services "$ECS_SERVICE_NAME" \
        --region "$AWS_REGION"
    
    log "Service deployment completed successfully ✓"
}

# Main deployment function
main() {
    log "Starting deployment to AWS ECS..."
    log "Region: $AWS_REGION"
    log "Cluster: $ECS_CLUSTER_NAME"
    log "Service: $ECS_SERVICE_NAME"
    log "Image Tag: $IMAGE_TAG"
    
    check_prerequisites
    create_ecr_repository
    
    local image_uri=$(build_and_push_image)
    local task_def_arn=$(update_task_definition "$image_uri")
    
    update_service "$task_def_arn"
    wait_for_deployment
    
    log "🎉 Deployment completed successfully!"
    log "Service URL: Check your ECS service for the load balancer endpoint"
}

# Handle script arguments
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "build-only")
        check_prerequisites
        create_ecr_repository
        build_and_push_image
        ;;
    "help")
        echo "Usage: $0 [deploy|build-only|help]"
        echo "  deploy     - Full deployment (default)"
        echo "  build-only - Only build and push image"
        echo "  help       - Show this help"
        ;;
    *)
        error "Unknown command: $1. Use 'help' for usage information."
        ;;
esac
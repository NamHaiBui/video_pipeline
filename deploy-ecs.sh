#!/bin/bash

# Video Pipeline ECS Deployment Script
# This script builds, pushes, and deploys the video pipeline to AWS ECS

set -e

# Configuration
PROJECT_NAME="video-pipeline"
ENVIRONMENT="${ENVIRONMENT:-production}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPOSITORY_NAME="${PROJECT_NAME}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check required tools
check_dependencies() {
    log_info "Checking dependencies..."
    
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install it first."
        exit 1
    fi
    
    log_success "All dependencies are available"
}

# Get AWS account ID
get_account_id() {
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    if [ -z "$AWS_ACCOUNT_ID" ]; then
        log_error "Failed to get AWS account ID"
        exit 1
    fi
    log_info "AWS Account ID: $AWS_ACCOUNT_ID"
}

# Create ECR repository if it doesn't exist
create_ecr_repository() {
    log_info "Creating ECR repository if it doesn't exist..."
    
    aws ecr describe-repositories --repository-names $ECR_REPOSITORY_NAME --region $AWS_REGION > /dev/null 2>&1 || {
        log_info "Creating ECR repository: $ECR_REPOSITORY_NAME"
        aws ecr create-repository \
            --repository-name $ECR_REPOSITORY_NAME \
            --region $AWS_REGION \
            --image-scanning-configuration scanOnPush=true
    }
    
    log_success "ECR repository ready"
}

# Build and push Docker image
build_and_push_image() {
    log_info "Building Docker image..."
    
    # Get ECR login token
    aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
    
    # Build image
    docker build -t $PROJECT_NAME:latest .
    
    # Tag image for ECR
    ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY_NAME"
    docker tag $PROJECT_NAME:latest $ECR_URI:latest
    docker tag $PROJECT_NAME:latest $ECR_URI:$(date +%Y%m%d-%H%M%S)
    
    # Push image
    log_info "Pushing image to ECR..."
    docker push $ECR_URI:latest
    docker push $ECR_URI:$(date +%Y%m%d-%H%M%S)
    
    log_success "Image pushed to ECR: $ECR_URI:latest"
}

# Deploy infrastructure using CloudFormation
deploy_infrastructure() {
    log_info "Deploying infrastructure..."
    
    # Get VPC and subnet information (you may need to modify this)
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)
    SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text --region $AWS_REGION | tr '\t' ',')
    
    if [ "$VPC_ID" == "None" ] || [ -z "$SUBNET_IDS" ]; then
        log_error "Could not find default VPC or subnets. Please specify VPC_ID and SUBNET_IDS manually."
        exit 1
    fi
    
    log_info "Using VPC: $VPC_ID"
    log_info "Using Subnets: $SUBNET_IDS"
    
    ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY_NAME"
    
    aws cloudformation deploy \
        --template-file cloudformation-infrastructure.yml \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --parameter-overrides \
            ProjectName=$PROJECT_NAME \
            Environment=$ENVIRONMENT \
            ECRRepositoryURI=$ECR_URI \
            VpcId=$VPC_ID \
            SubnetIds=$SUBNET_IDS \
        --capabilities CAPABILITY_NAMED_IAM \
        --region $AWS_REGION
    
    log_success "Infrastructure deployed"
}

# Update ECS task definition
update_task_definition() {
    log_info "Updating ECS task definition..."
    
    ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY_NAME:latest"
    
    # Get the role ARNs from CloudFormation stack
    EXECUTION_ROLE_ARN=$(aws cloudformation describe-stacks \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskExecutionRoleArn`].OutputValue' \
        --output text --region $AWS_REGION)
    
    TASK_ROLE_ARN=$(aws cloudformation describe-stacks \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskRoleArn`].OutputValue' \
        --output text --region $AWS_REGION)
    
    # Update the task definition template
    sed -e "s|YOUR_ACCOUNT_ID|$AWS_ACCOUNT_ID|g" \
        -e "s|YOUR_ECR_REPOSITORY_URI|$ECR_URI|g" \
        -e "s|arn:aws:iam::YOUR_ACCOUNT_ID:role/ecsTaskExecutionRole|$EXECUTION_ROLE_ARN|g" \
        -e "s|arn:aws:iam::YOUR_ACCOUNT_ID:role/video-pipeline-task-role|$TASK_ROLE_ARN|g" \
        ecs-task-definition.json > ecs-task-definition-updated.json
    
    # Register the task definition
    aws ecs register-task-definition \
        --cli-input-json file://ecs-task-definition-updated.json \
        --region $AWS_REGION
    
    log_success "ECS task definition updated"
}

# Create or update ECS service
deploy_service() {
    log_info "Deploying ECS service..."
    
    CLUSTER_NAME=$(aws cloudformation describe-stacks \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' \
        --output text --region $AWS_REGION)
    
    TARGET_GROUP_ARN=$(aws cloudformation describe-stacks \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --query 'Stacks[0].Outputs[?OutputKey==`TargetGroupArn`].OutputValue' \
        --output text --region $AWS_REGION)
    
    SECURITY_GROUP_ID=$(aws cloudformation describe-stacks \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --query 'Stacks[0].Outputs[?OutputKey==`ECSSecurityGroupId`].OutputValue' \
        --output text --region $AWS_REGION)
    
    SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text --region $AWS_REGION | tr '\t' ',')
    
    SERVICE_NAME="$PROJECT_NAME-service-$ENVIRONMENT"
    
    # Check if service exists
    if aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $AWS_REGION > /dev/null 2>&1; then
        log_info "Updating existing ECS service..."
        aws ecs update-service \
            --cluster $CLUSTER_NAME \
            --service $SERVICE_NAME \
            --task-definition "$PROJECT_NAME-task:LATEST" \
            --region $AWS_REGION
    else
        log_info "Creating new ECS service..."
        aws ecs create-service \
            --cluster $CLUSTER_NAME \
            --service-name $SERVICE_NAME \
            --task-definition "$PROJECT_NAME-task" \
            --desired-count 1 \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SECURITY_GROUP_ID],assignPublicIp=ENABLED}" \
            --load-balancers "targetGroupArn=$TARGET_GROUP_ARN,containerName=video-pipeline,containerPort=3000" \
            --region $AWS_REGION
    fi
    
    log_success "ECS service deployed"
}

# Main deployment process
main() {
    log_info "Starting Video Pipeline ECS deployment..."
    log_info "Project: $PROJECT_NAME"
    log_info "Environment: $ENVIRONMENT"
    log_info "Region: $AWS_REGION"
    
    check_dependencies
    get_account_id
    create_ecr_repository
    build_and_push_image
    deploy_infrastructure
    update_task_definition
    deploy_service
    
    # Get the load balancer URL
    ALB_URL=$(aws cloudformation describe-stacks \
        --stack-name "$PROJECT_NAME-infrastructure-$ENVIRONMENT" \
        --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerURL`].OutputValue' \
        --output text --region $AWS_REGION)
    
    log_success "Deployment completed!"
    log_info "Application URL: http://$ALB_URL"
    log_info "Health check: http://$ALB_URL/health"
    log_info "API docs: http://$ALB_URL/"
    
    # Clean up temporary files
    rm -f ecs-task-definition-updated.json
}

# Script options
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "build-only")
        check_dependencies
        get_account_id
        create_ecr_repository
        build_and_push_image
        ;;
    "infrastructure-only")
        check_dependencies
        get_account_id
        deploy_infrastructure
        ;;
    "service-only")
        check_dependencies
        get_account_id
        update_task_definition
        deploy_service
        ;;
    *)
        echo "Usage: $0 [deploy|build-only|infrastructure-only|service-only]"
        echo "  deploy: Full deployment (default)"
        echo "  build-only: Build and push Docker image only"
        echo "  infrastructure-only: Deploy CloudFormation infrastructure only"
        echo "  service-only: Update task definition and service only"
        exit 1
        ;;
esac

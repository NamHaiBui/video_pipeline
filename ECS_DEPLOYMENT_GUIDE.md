# Video Pipeline ECS Deployment Guide

## Overview

This guide covers deploying the Video Pipeline to AWS ECS (Elastic Container Service) using Fargate. The application has been optimized for production deployment without LocalStack dependencies.

## Prerequisites

### Required Software
- AWS CLI (v2.x or later)
- Docker (20.x or later)
- Docker Compose (v2.x or later)

### AWS Account Setup
- AWS account with sufficient permissions
- AWS CLI configured with credentials
- Access to ECS, ECR, S3, DynamoDB, SQS, and CloudWatch services

## Quick Start

### 1. Setup AWS Infrastructure

```bash
# Create all required AWS resources
./setup-aws-infrastructure.sh

# This creates:
# - S3 buckets for audio, video, and metadata
# - DynamoDB tables for episodes and metadata
# - SQS queue for job processing
# - ECS cluster
# - ECR repository
# - EFS file system
# - CloudWatch log groups
```

### 2. Configure Environment

```bash
# Review the generated configuration
cat .env.aws

# Set your credentials manually in .env.aws:
# AWS_ACCESS_KEY_ID=your_access_key_here
# AWS_SECRET_ACCESS_KEY=your_secret_key_here
# YOUTUBE_API_KEY=your_youtube_api_key_here
```

### 3. Deploy to ECS

```bash
# Deploy the application
./deploy-ecs.sh

# This will:
# - Build and push Docker images to ECR
# - Create/update ECS task definition
# - Deploy to ECS service
# - Wait for deployment to complete
```

## Detailed Deployment Steps

### Step 1: Infrastructure Setup

The infrastructure setup script creates all necessary AWS resources:

```bash
./setup-aws-infrastructure.sh
```

**What gets created:**
- **S3 Buckets**: For storing audio files, video files, and metadata
- **DynamoDB Tables**: For podcast episodes and video metadata
- **SQS Queue**: For processing job queue with dead letter queue
- **ECS Cluster**: Fargate cluster for running containers
- **ECR Repository**: For storing Docker images
- **EFS File System**: For persistent storage across containers
- **CloudWatch Log Groups**: For application logging
- **SSM Parameters**: For storing configuration securely

### Step 2: Environment Configuration

After infrastructure setup, configure your environment:

```bash
# Copy the generated configuration
cp .env.aws .env

# Edit .env to add your credentials
nano .env
```

**Required environment variables:**
```bash
# AWS Credentials
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_REGION=us-east-1

# External APIs
YOUTUBE_API_KEY=your_youtube_api_key_here

# Generated by setup script
S3_AUDIO_BUCKET_NAME=video-pipeline-audio-12345
S3_VIDEO_BUCKET_NAME=video-pipeline-video-12345
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/video-pipeline-jobs
VIDEO_TRIMMING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming
DYNAMODB_PODCAST_EPISODES_TABLE=video-pipeline-episodes
```

### Step 3: Docker Image Build and Push

```bash
# Build production image
./docker-helper.sh build-prod

# Or deploy directly (includes build)
./deploy-ecs.sh
```

### Step 4: ECS Deployment

The deployment script handles the complete ECS deployment:

```bash
./deploy-ecs.sh
```

**Deployment process:**
1. Creates ECR repository if needed
2. Builds production Docker image
3. Tags and pushes image to ECR
4. Updates ECS task definition
5. Updates ECS service
6. Waits for deployment to stabilize

## Architecture

### Container Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                      ECS Fargate Task                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────────┐  │
│  │  bgutil-provider│◄───┤        video-pipeline           │  │
│  │   Port: 4416    │    │         Port: 3000              │  │
│  └─────────────────┘    └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     AWS Services                            │
├─────────────────────────────────────────────────────────────┤
│  S3 Buckets  │  DynamoDB  │  SQS Queue  │  CloudWatch      │
└─────────────────────────────────────────────────────────────┘
```

### Network Configuration
- **VPC**: Uses default VPC or your configured VPC
- **Subnets**: Public subnets for Fargate tasks
- **Security Groups**: Allow HTTP traffic on port 3000
- **Load Balancer**: Optional ALB for production traffic

## Configuration Management

### Environment Variables in ECS

The ECS task definition uses AWS Systems Manager Parameter Store for secure configuration:

```json
"secrets": [
  {
    "name": "AWS_ACCESS_KEY_ID",
    "valueFrom": "arn:aws:ssm:us-east-1:123456789:parameter/video-pipeline/aws-access-key-id"
  },
  {
    "name": "S3_AUDIO_BUCKET_NAME",
    "valueFrom": "arn:aws:ssm:us-east-1:123456789:parameter/video-pipeline/s3-audio-bucket"
  }
]
```

### Adding Secrets to Parameter Store

```bash
# Add AWS credentials
aws ssm put-parameter \
  --name "/video-pipeline/aws-access-key-id" \
  --value "your-access-key" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/video-pipeline/aws-secret-access-key" \
  --value "your-secret-key" \
  --type "SecureString"

# Add YouTube API key
aws ssm put-parameter \
  --name "/video-pipeline/youtube-api-key" \
  --value "your-youtube-api-key" \
  --type "SecureString"
```

## Monitoring and Logging

### CloudWatch Logs
- Log Group: `/ecs/video-pipeline`
- Log Streams: Separate streams for each container

### Health Checks
- **Application**: HTTP GET `/health`
- **bgutil-provider**: HTTP GET `/health`
- **ECS Health Checks**: Configured in task definition

### Monitoring Dashboards

Create CloudWatch dashboard for monitoring:

```bash
# CPU and Memory utilization
# Request count and response times
# Error rates and failed health checks
# SQS queue metrics
```

## Scaling Configuration

### Auto Scaling
```json
{
  "serviceName": "video-pipeline-service",
  "minCapacity": 1,
  "maxCapacity": 10,
  "targetValue": 70.0,
  "scaleOutCooldown": 300,
  "scaleInCooldown": 300
}
```

### Manual Scaling
```bash
# Update service capacity
aws ecs update-service \
  --cluster video-pipeline-cluster \
  --service video-pipeline-service \
  --desired-count 3
```

## Troubleshooting

### Common Issues

#### 1. Task Fails to Start
```bash
# Check task logs
aws logs get-log-events \
  --log-group-name "/ecs/video-pipeline" \
  --log-stream-name "video-pipeline/container-id"

# Check task definition
aws ecs describe-tasks \
  --cluster video-pipeline-cluster \
  --tasks task-arn
```

#### 2. Image Pull Errors
```bash
# Verify ECR repository exists
aws ecr describe-repositories --repository-names video-pipeline

# Check ECR login
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789.dkr.ecr.us-east-1.amazonaws.com
```

#### 3. Health Check Failures
```bash
# Test health endpoint directly
curl -f http://task-ip:3000/health

# Check bgutil-provider connectivity
curl -f http://localhost:4416/health
```

#### 4. Permission Issues
```bash
# Verify task role permissions
aws iam get-role --role-name video-pipeline-task-role

# Check parameter store access
aws ssm get-parameter --name "/video-pipeline/s3-audio-bucket"
```

### Debugging Commands

```bash
# View service events
aws ecs describe-services \
  --cluster video-pipeline-cluster \
  --services video-pipeline-service

# Check task status
aws ecs list-tasks \
  --cluster video-pipeline-cluster \
  --service-name video-pipeline-service

# View container logs
aws logs tail /ecs/video-pipeline --follow
```

## Security Best Practices

### IAM Roles
- **Task Execution Role**: Minimal permissions for ECS
- **Task Role**: Application-specific AWS service access
- **Deployment Role**: CI/CD pipeline permissions

### Network Security
- **Security Groups**: Restrict inbound traffic
- **VPC Configuration**: Use private subnets for production
- **SSL/TLS**: Enable HTTPS with ALB and ACM certificates

### Container Security
- **Non-root User**: Containers run as user ID 1001
- **Minimal Base Image**: Alpine Linux for smaller attack surface
- **Image Scanning**: ECR vulnerability scanning enabled
- **Secret Management**: SSM Parameter Store for sensitive data

## Maintenance

### Updates and Deployments
```bash
# Deploy new version
./deploy-ecs.sh

# Rollback to previous version
aws ecs update-service \
  --cluster video-pipeline-cluster \
  --service video-pipeline-service \
  --task-definition video-pipeline-task:previous-revision
```

### Backup and Recovery
- **S3 Versioning**: Enabled on all buckets
- **DynamoDB Backups**: Point-in-time recovery enabled
- **EFS Backups**: Automatic backup configuration
- **Configuration Backup**: SSM parameters exported regularly

### Cost Optimization
- **Fargate Spot**: Consider Spot instances for non-critical workloads
- **Resource Right-sizing**: Monitor and adjust CPU/memory allocation
- **Auto Scaling**: Scale down during low usage periods
- **Data Lifecycle**: S3 lifecycle policies for old files

## Support

For deployment issues:
1. Check the troubleshooting section above
2. Review CloudWatch logs
3. Verify AWS service limits and quotas
4. Test individual components (Docker build, AWS connectivity)

## Summary

The Video Pipeline is now ready for production deployment on AWS ECS with:
- ✅ Complete infrastructure automation
- ✅ Secure configuration management
- ✅ Production-ready container setup
- ✅ Comprehensive monitoring and logging
- ✅ Auto-scaling capabilities
- ✅ Security best practices

Run `./setup-aws-infrastructure.sh` followed by `./deploy-ecs.sh` to get started!

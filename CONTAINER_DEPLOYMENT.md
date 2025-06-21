# Video Pipeline Containerization Guide

This document provides comprehensive instructions for containerizing and deploying the Video Pipeline application.

## Overview

The Video Pipeline is a podcast processing system that converts YouTube videos into podcast episodes. It consists of:

- **Main Application**: Node.js/TypeScript application for video processing
- **bgutil-ytdlp-pot-provider**: External dependency for YouTube content processing
- **AWS Services**: S3, DynamoDB, SQS for cloud storage and processing
- **LocalStack**: Local AWS emulation for development

## Container Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Video Pipeline System                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────────┐  │
│  │  bgutil-provider│    │        video-pipeline           │  │
│  │   (Port 4416)   │◄───┤         (Port 3000)            │  │
│  └─────────────────┘    └─────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              LocalStack (Development)                   │  │
│  │  S3 | DynamoDB | SQS | CloudWatch (Port 4566)         │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Development with LocalStack

```bash
# Start development environment
./docker-helper.sh dev

# Check status
./docker-helper.sh status

# View logs
./docker-helper.sh logs-dev

# Stop all services
./docker-helper.sh stop
```

### Production Deployment

```bash
# Build production image
./docker-helper.sh build-prod

# Start production environment
./docker-helper.sh prod

# Deploy to AWS ECS
./deploy-ecs.sh
```

## Docker Files

### 1. Dockerfile (Main)
- Multi-stage build for development and production
- Based on Node.js 20 Alpine for security and size
- Includes system dependencies (ffmpeg, yt-dlp, etc.)
- Non-root user for security

### 2. Dockerfile.production
- Optimized multi-stage build for production
- Separate build stage for smaller final image
- Production-ready configuration

### 3. Docker Compose Files

#### docker-compose.yml
- Main compose file for production
- Includes bgutil-provider dependency
- Configurable environment variables
- Health checks and restart policies

#### docker-compose.local.yml
- Development environment with LocalStack
- Volume mounts for live code reloading
- Debug logging enabled
- LocalStack integration

#### docker-compose.prod.yml
- Production-optimized configuration
- Resource limits and reservations
- Enhanced logging and monitoring
- Persistent volumes

## Environment Configuration

### Required Environment Variables

```bash
# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# S3 Configuration
S3_AUDIO_BUCKET_NAME=podcast-audio-bucket
S3_VIDEO_BUCKET_NAME=podcast-video-bucket

# DynamoDB Configuration
DYNAMODB_PODCAST_EPISODES_TABLE=PodcastEpisodes

# SQS Configuration
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/queue-name
VIDEO_TRIMMING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/221082194281/test-video-trimming
```

### Optional Environment Variables

```bash
# Processing Configuration
MAX_CONCURRENT_JOBS=2
POLLING_INTERVAL_MS=30000
DEFAULT_VIDEO_QUALITY=720p
PREFERRED_AUDIO_FORMAT=mp3

# Feature Flags
ENABLE_SQS_POLLING=true
S3_UPLOAD_ENABLED=true
PODCAST_CONVERSION_ENABLED=true

# YouTube API
YOUTUBE_API_KEY=your_youtube_api_key
```

## Development Workflow

### 1. Local Development Setup

```bash
# Clone the repository
git clone <repository-url>
cd video_pipeline

# Copy environment template
cp .env.example .env

# Start development environment
./docker-helper.sh dev

# Initialize LocalStack resources
./docker-helper.sh init-localstack
```

### 2. Testing

```bash
# Check application health
./docker-helper.sh health

# Test LocalStack integration
curl http://localhost:4566/_localstack/health

# Test main application
curl http://localhost:3000/health
```

### 3. Debugging

```bash
# View real-time logs
./docker-helper.sh logs-dev

# View specific service logs
./docker-helper.sh logs-dev bgutil-provider

# Check container status
./docker-helper.sh status

# Access container shell
docker exec -it video-pipeline-local /bin/sh
```

## Production Deployment

### 1. AWS ECS Deployment

Prerequisites:
- AWS CLI configured
- Docker installed
- ECS cluster created
- Required IAM roles configured

```bash
# Set environment variables
export AWS_REGION=us-east-1
export ECR_REPOSITORY_NAME=video-pipeline
export ECS_CLUSTER_NAME=video-pipeline-cluster
export ECS_SERVICE_NAME=video-pipeline-service

# Deploy to ECS
./deploy-ecs.sh
```

### 2. AWS Infrastructure Requirements

#### IAM Roles
- **ECS Task Execution Role**: For container execution
- **ECS Task Role**: For AWS service access

#### Required AWS Services
- **ECR**: Container registry
- **ECS**: Container orchestration
- **S3**: File storage
- **DynamoDB**: Metadata storage
- **SQS**: Job queue
- **CloudWatch**: Logging and monitoring
- **Systems Manager**: Secret management

#### Security Groups
- Allow inbound traffic on port 3000 (application)
- Allow outbound traffic for AWS services
- Allow communication between containers

### 3. Monitoring and Logging

```bash
# CloudWatch Logs
aws logs describe-log-groups --log-group-name-prefix "/ecs/video-pipeline"

# ECS Service Status
aws ecs describe-services --cluster video-pipeline-cluster --services video-pipeline-service

# Container Health
aws ecs describe-tasks --cluster video-pipeline-cluster --tasks <task-arn>
```

## Troubleshooting

### Common Issues

#### 1. Container Won't Start
```bash
# Check logs
./docker-helper.sh logs-dev

# Verify dependencies
docker-compose -f docker-compose.local.yml ps

# Check resource usage
docker stats
```

#### 2. bgutil-provider Connection Issues
```bash
# Verify bgutil-provider is running
curl http://localhost:4416/health

# Check network connectivity
docker network ls
docker network inspect video-pipeline-local
```

#### 3. LocalStack Issues
```bash
# Check LocalStack status
curl http://localhost:4566/_localstack/health

# Restart LocalStack
docker-compose -f docker-compose.local.yml restart localstack

# Initialize resources
./docker-helper.sh init-localstack
```

#### 4. AWS Services Issues
```bash
# Check AWS credentials
aws sts get-caller-identity

# Verify S3 access
aws s3 ls s3://your-bucket-name

# Check DynamoDB tables
aws dynamodb list-tables
```

### Performance Optimization

#### 1. Container Resources
```yaml
# Adjust resource limits in docker-compose files
deploy:
  resources:
    limits:
      memory: 2G
      cpus: '1.0'
    reservations:
      memory: 1G
      cpus: '0.5'
```

#### 2. Build Optimization
- Use multi-stage builds
- Minimize image layers
- Use .dockerignore effectively
- Cache dependencies

#### 3. Runtime Optimization
- Configure appropriate worker processes
- Set optimal environment variables
- Use health checks for better orchestration

## Security Considerations

### 1. Container Security
- Non-root user execution
- Minimal base image (Alpine)
- Regular security updates
- Secret management via AWS Systems Manager

### 2. Network Security
- Private subnets for containers
- Security groups with minimal access
- VPC endpoints for AWS services
- SSL/TLS for all communications

### 3. Data Security
- Encrypted storage (S3, EFS)
- Encrypted in-transit data
- IAM roles with minimal permissions
- Regular security audits

## Maintenance

### 1. Updates
```bash
# Update base images
docker pull node:20-alpine
docker pull brainicism/bgutil-ytdlp-pot-provider:latest

# Rebuild containers
./docker-helper.sh build-prod

# Deploy updates
./deploy-ecs.sh
```

### 2. Backup
- EFS snapshots for persistent data
- S3 versioning for processed files
- DynamoDB point-in-time recovery
- Regular configuration backups

### 3. Monitoring
- CloudWatch metrics and alarms
- ECS service monitoring
- Application performance monitoring
- Cost optimization reviews

## Advanced Configuration

### 1. Custom Networks
```yaml
networks:
  video-pipeline-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### 2. Volume Management
```yaml
volumes:
  video-pipeline-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/video-pipeline/data
```

### 3. Load Balancing
- Application Load Balancer (ALB)
- Target group health checks
- Auto-scaling configuration
- Blue-green deployments

This containerization setup provides a robust, scalable, and maintainable deployment solution for the Video Pipeline application.

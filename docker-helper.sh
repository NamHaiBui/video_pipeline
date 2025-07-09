#!/bin/bash

# Container Management Script for Video Pipeline
# Provides easy commands for building, running, and managing containers

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# Build functions
build_dev() {
    log "Building development image..."
    docker build -f Dockerfile -t video-episode-downloader:dev --target development .
}

build_prod() {
    log "Building production image..."
    docker build -f Dockerfile.production -t video-episode-downloader:prod --target production .
}

# Run functions
run_prod() {
    log "Starting production environment..."
    docker-compose -f docker-compose.yml up -d
    log "Production environment started!"
    info "Access the application at: http://localhost:3000"
}

# Stop functions
stop_all() {
    log "Stopping all containers..."
    docker-compose -f docker-compose.yml down
    docker-compose -f docker-compose.prod.yml down
    log "All containers stopped!"
}

# Cleanup functions
cleanup() {
    log "Cleaning up containers and images..."
    docker-compose -f docker-compose.yml down --volumes --remove-orphans
    docker-compose -f docker-compose.prod.yml down --volumes --remove-orphans
    docker system prune -f
    log "Cleanup completed!"
}

# Logs functions
logs_app() {
    docker-compose -f docker-compose.yml logs -f "${2:-video-episode-downloader}"
}

logs_prod() {
    docker-compose -f docker-compose.prod.yml logs -f "${2:-video-episode-downloader}"
}

# Health check
health_check() {
    local url=${1:-http://localhost:3000/health}
    log "Checking application health at $url..."
    
    if curl -f -s "$url" > /dev/null; then
        log "✅ Application is healthy!"
        curl -s "$url" | jq . 2>/dev/null || curl -s "$url"
    else
        error "❌ Application health check failed!"
    fi
}

# Show status
status() {
    log "Container Status:"
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" --filter "name=video-episode-downloader*" --filter "name=bgutil*"
    
    echo ""
    log "Images:"
    docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | grep -E "(video-pipeline|bgutil)"
}

# Main menu
show_help() {
    echo "Video Pipeline Container Management"
    echo "=================================="
    echo ""
    echo "Build Commands:"
    echo "  build-dev          Build development image"
    echo "  build-prod         Build production image"
    echo ""
    echo "Run Commands:"
    echo "  prod               Start production environment"
    echo ""
    echo "Management Commands:"
    echo "  stop               Stop all containers"
    echo "  cleanup            Stop containers and clean up images"
    echo "  status             Show container and image status"
    echo ""
    echo "Utility Commands:"
    echo "  logs-app [service] Show application logs (default: video-pipeline)"
    echo "  logs-prod [service] Show production logs (default: video-pipeline)"
    echo "  health [url]       Check application health (default: localhost:3000)"
    echo ""
    echo "Examples:"
    echo "  $0 prod            # Start production environment"
    echo "  $0 logs-app        # Show video-pipeline logs"
    echo "  $0 logs-app bgutil-provider # Show bgutil-provider logs"
    echo "  $0 health          # Check local health"
    echo "  $0 status          # Show all container status"
}

# Main command dispatcher
case "${1:-help}" in
    "build-dev")
        build_dev
        ;;
    "build-prod")
        build_prod
        ;;
    "prod")
        run_prod
        ;;
    "stop")
        stop_all
        ;;
    "cleanup")
        cleanup
        ;;
    "logs-app")
        logs_app "$@"
        ;;
    "logs-prod")
        logs_prod "$@"
        ;;
    "health")
        health_check "$2"
        ;;
    "status")
        status
        ;;
    "help"|"--help"|"-h")
        show_help
        ;;
    *)
        error "Unknown command: $1"
        echo ""
        show_help
        ;;
esac

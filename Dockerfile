# Multi-stage Dockerfile for Video Pipeline
FROM node:20-alpine3.19 AS base

# Set timezone
ENV TZ=UTC

# Install system dependencies needed for downloading and processing
RUN apk add --no-cache \
    curl \
    wget \
    xz \
    tar \
    python3 \
    py3-pip \
    ffmpeg \
    ca-certificates \
    tzdata \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Development stage
FROM base AS development

# Create necessary directories
RUN mkdir -p /app/bin \
    /app/downloads \
    /app/downloads/podcasts \
    /app/downloads/audio \
    /app/temp \
    /app/.config/yt-dlp/plugins \
    && chmod -R 755 /app/downloads /app/temp /app/.config

# Create symlinks to system binaries so the app can find them
RUN ln -sf /usr/bin/ffmpeg /app/bin/ffmpeg && \
    ln -sf /usr/bin/ffprobe /app/bin/ffprobe

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install all dependencies (including dev dependencies)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Expose port
EXPOSE 3000

# Development command
CMD ["npm", "run", "dev"]

# Production stage
FROM base AS production

# Create necessary directories
RUN mkdir -p /app/bin \
    /app/downloads \
    /app/downloads/podcasts \
    /app/downloads/audio \
    /app/temp \
    /app/.config/yt-dlp/plugins \
    && chmod -R 755 /app/downloads /app/temp /app/.config

# Create symlinks to system binaries so the app can find them
RUN ln -sf /usr/bin/ffmpeg /app/bin/ffmpeg && \
    ln -sf /usr/bin/ffprobe /app/bin/ffprobe

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Copy source code (needed for setup_binaries.ts during postinstall)
COPY src/ ./src/

# Copy .config directory for yt-dlp plugins and configuration
COPY .config/ ./.config/

# Install all dependencies (including dev dependencies needed for postinstall)
RUN npm ci

COPY .env ./

# Build the TypeScript application (before removing dev dependencies)
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S -u 1001 -G nodejs nodejs

# Change ownership of the app directory to the nodejs user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Add labels for better container management
LABEL maintainer="episode_video_downloader" \
      description="Podcast Processing Pipeline - Convert YouTube videos to podcast episodes" \
      version="1.0.0"

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    ENABLE_SQS_POLLING=true \
    S3_UPLOAD_ENABLED=true \
    PODCAST_CONVERSION_ENABLED=true

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "dist/server.js"]

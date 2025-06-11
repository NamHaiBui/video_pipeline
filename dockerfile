FROM node:18 as builder

# Install system dependencies required by your setup_binaries.ts script
# (e.g., wget, xz-utils, tar for ffmpeg download, python3 for yt-dlp execution)
RUN apt-get update && \
    apt-get install -y python3 curl wget xz-utils tar && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

# Install all dependencies, including devDependencies.
# This will trigger the "postinstall" script in your package.json:
# "postinstall": "tsx src/scripts/setup_binaries.ts"
# which should download yt-dlp and ffmpeg to ./bin
RUN npm install

# Copy the rest of the application source code
COPY . .

# Build the TypeScript project (output to ./dist)
RUN npm run build

# Stage 2: Production
FROM node:18-slim

# Install only Python, as yt-dlp and ffmpeg will be copied from the builder stage's ./bin directory.
# python3 is needed for the yt-dlp binary/script to run.
RUN apt-get update && \
    apt-get install -y python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
# Install only production dependencies
RUN npm install --omit=dev

# Copy compiled code from builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Copy binaries (yt-dlp, ffmpeg) from builder stage
# Your setup_binaries.ts script should have placed them in /usr/src/app/bin
COPY --from=builder /usr/src/app/bin ./bin

# Your application (src/lib/ytdlpWrapper.ts) resolves paths to these binaries
# relative to its location in `dist`, e.g., path.resolve(__dirname, '..', '..', 'bin').
# Ensure they are executable (your setup_binaries.ts script should also handle this).
RUN chmod +x /usr/src/app/bin/yt-dlp /usr/src/app/bin/ffmpeg 2>/dev/null || true

# Expose the port the app runs on.
# Your src/server.ts uses process.env.PORT || 3000.
# This will be set to 3000 by docker-compose.
EXPOSE 3000

# Command to run the application
CMD ["node", "dist/server.js"]
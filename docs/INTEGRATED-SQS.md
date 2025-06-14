# SQS Integration with In-Process Job Queue

This document describes the integrated SQS polling functionality that allows the server to process video download jobs from an SQS queue.

## Overview

The server now includes an integrated SQS polling mechanism that runs in the same process. It continuously polls an AWS SQS queue for video download jobs and maintains an in-memory job queue with a configurable concurrency limit (default: 2).

## Features

- **Integrated SQS Polling**: No separate worker needed - polls SQS directly from the main server process
- **Configurable Job Queue**: Maintains an in-memory job queue with configurable concurrency (default: 2)
- **Automatic Scaling**: Polls more messages as jobs complete, keeping the job queue at optimal capacity
- **Resource Efficient**: Single process handles both API requests and background jobs
- **CloudWatch Logging**: Detailed logs sent to CloudWatch
- **LocalStack Support**: Works with LocalStack for local testing

## Configuration

To configure SQS polling, set the following environment variables:

```
ENABLE_SQS_POLLING=true           # Set to 'false' to disable SQS polling
SQS_QUEUE_URL=<your-queue-url>    # Required for SQS polling
MAX_CONCURRENT_JOBS=2             # Maximum number of concurrent download jobs (default: 2)
POLLING_INTERVAL_MS=30000         # Time between polling attempts in ms (default: 30000)
```

## How It Works

1. **Server Startup**: When the server starts, it initializes the SQS polling module if `ENABLE_SQS_POLLING` is not set to `false`.

2. **Initial Poll**: The server immediately polls the SQS queue for up to `MAX_CONCURRENT_JOBS` messages.

3. **Job Processing**: For each message, the server:
   - Parses the job data (URL and job ID)
   - Adds the job to the in-memory job tracker
   - Processes the download job asynchronously
   - Deletes the message from the SQS queue
   
4. **Continuous Polling**: The server polls for new messages at regular intervals (controlled by `POLLING_INTERVAL_MS`).

5. **Dynamic Scaling**: When a job completes, the server immediately polls for more messages if it has capacity.

## Testing with LocalStack

To test the SQS integration with LocalStack:

1. Start LocalStack:
   ```bash
   npm run localstack:start
   ```

2. Send test messages to the SQS queue:
   ```bash
   npm run test:job-queue  # Sends 5 test messages
   ```

3. Start the server with SQS polling:
   ```bash
   LOCALSTACK=true ENABLE_SQS_POLLING=true npm run server
   ```

4. Watch the server logs to observe job processing.

## Deployment

When deploying to production, configure the environment variables in your deployment environment. The server container will automatically start polling the configured SQS queue on startup.

Example docker-compose configuration:

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - NODE_ENV=production
      - ENABLE_SQS_POLLING=true
      - SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/video-pipeline-jobs
      - MAX_CONCURRENT_JOBS=2
      - POLLING_INTERVAL_MS=30000
```

### Docker Deployment

The SQS polling functionality is integrated directly into the main server container.
No separate worker container is needed.

```bash
# Build and run the server with SQS polling enabled
docker build -t video-pipeline-server .
docker run -d -p 3000:3000 --env-file .env -e ENABLE_SQS_POLLING=true video-pipeline-server
```

## Monitoring

Monitor the job processing through:

1. Server logs (stdout/stderr)
2. CloudWatch logs (if configured)
3. The `/health` endpoint for overall server health

## Troubleshooting

1. **No messages being processed**:
   - Check `ENABLE_SQS_POLLING` is set to `true`
   - Verify `SQS_QUEUE_URL` is correct
   - Check IAM permissions for SQS access

2. **Server running at high CPU**:
   - Try reducing `MAX_CONCURRENT_JOBS` to limit parallelism
   - Increase `POLLING_INTERVAL_MS` to reduce polling frequency

# Server Protection Test Guide

## yt-dlp Error Protection Verification

The server now has comprehensive protection against yt-dlp failures. Here's how to verify it's working:

### Protection Features Implemented:

1. **Job Isolation**: Individual job failures don't crash the server
2. **Error Categorization**: yt-dlp errors are properly categorized and logged
3. **Graceful Abandonment**: Failed jobs are marked as 'error' and abandoned safely
4. **Resource Cleanup**: Metadata files and resources are cleaned up even on failures
5. **Continued Operation**: Server continues processing other jobs after failures

### Test Methods:

#### 1. Health Check Verification
```bash
curl http://localhost:3000/health
```
Should show:
- `ytdlpErrorProtection: 'enabled'`
- `errorHandling.ytdlpProtected: true`
- `errorHandling.jobIsolation: true`

#### 2. Failed URL Test
Submit an invalid YouTube URL to test error handling:
```bash
curl -X POST http://localhost:3000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://youtube.com/watch?v=invalid_video_id_test"}'
```

#### 3. Monitor Job Status
Check that the job fails gracefully:
```bash
curl http://localhost:3000/api/jobs
```
Failed jobs should show:
- `status: 'error'`
- `error: 'yt-dlp error (job abandoned): ...'`

#### 4. Server Continuity Test
- Submit multiple jobs (some valid, some invalid)
- Verify that invalid jobs fail without affecting valid ones
- Confirm server continues running and accepting new requests

### Expected Behavior:

✅ **Server Stability**: Server never crashes due to yt-dlp errors
✅ **Error Logging**: Clear, categorized error messages in logs
✅ **Job Tracking**: Failed jobs properly marked with detailed error info
✅ **Resource Management**: Cleanup occurs even on failures
✅ **Continued Service**: Other jobs and server operations unaffected

### Log Messages to Look For:

- `"yt-dlp operation failed for job X - server protected, abandoning job"`
- `"Safe yt-dlp wrapper caught error"`
- `"yt-dlp error (job abandoned): ..."`
- `"server protected from tool failures"`

The server will continue running normally even when yt-dlp encounters errors, network issues, or invalid URLs.

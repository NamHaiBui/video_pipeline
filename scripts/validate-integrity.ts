#!/usr/bin/env tsx
import { IntegrityValidator } from '../src/lib/integrityValidator.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const limit = parseInt(process.env.INTEGRITY_LIMIT || '200', 10);
  const createdAfter = process.env.INTEGRITY_CREATED_AFTER; // ISO date
  const verifyS3 = process.env.INTEGRITY_VERIFY_S3 === '1' || process.env.INTEGRITY_VERIFY_S3 === 'true';
  const requiredKeys = (process.env.INTEGRITY_REQUIRED_KEYS || 'videoLocation,master_m3u8')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const validator = IntegrityValidator.fromEnv();
  const summary = await validator.validate({
    limit,
    createdAfter,
    verifyS3,
    requiredAdditionalKeys: requiredKeys,
    enforceVideoWithMaster: true,
  });

  // Pretty print summary
  console.log(JSON.stringify(summary, null, 2));

  if (summary.errors > 0) {
    process.exitCode = 2;
  } else if (summary.warnings > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Integrity validation failed to execute:', err);
  process.exit(99);
});

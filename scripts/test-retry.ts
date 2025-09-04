import { withRetry } from '../src/lib/utils/concurrency.js';

async function main() {
  let attempts = 0;
  const start = Date.now();
  try {
    await withRetry(async () => {
      attempts++;
      throw new Error('transient');
    }, { attempts: 3, baseDelayMs: 10, label: 'test' });
    console.error('FAIL: expected to throw');
    process.exit(1);
  } catch {
    const dur = Date.now() - start;
    if (attempts !== 3) {
      console.error(`FAIL: expected 3 attempts, got ${attempts}`);
      process.exit(1);
    }
    console.log('PASS: retry exhaustion with attempts=', attempts, 'duration(ms)=', dur);
  }

  // Success after retries
  attempts = 0;
  const value = await withRetry(async () => {
    attempts++;
    if (attempts < 2) throw new Error('once');
    return 42;
  }, { attempts: 3, baseDelayMs: 10, label: 'test2' });
  if (value !== 42 || attempts !== 2) {
    console.error('FAIL: expected value=42 and attempts=2');
    process.exit(1);
  }
  console.log('PASS: success after retry, value=', value, 'attempts=', attempts);
}

main().catch(e => { console.error(e); process.exit(1); });

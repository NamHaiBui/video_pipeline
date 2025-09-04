import { Semaphore, withSemaphore, metrics } from '../src/lib/utils/concurrency.js';

async function main() {
  const sem = new Semaphore(3);
  let peak = 0;
  const running: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    running.push(withSemaphore(sem, 'test', async () => {
      peak = Math.max(peak, sem.inFlightCount);
      await new Promise(r => setTimeout(r, 50));
    }));
  }
  await Promise.all(running);
  console.log('Peak in-flight:', peak);
  console.log('Metrics snapshot:', JSON.stringify(metrics.snapshot()));
  if (peak > 3) {
    console.error('FAIL: concurrency exceeded.');
    process.exit(1);
  }
  console.log('PASS');
}

main().catch(err => { console.error(err); process.exit(1); });

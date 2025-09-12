# ECS optimization: Fargate vs. Fargate Spot

This note documents how the app detects and handles Fargate on-demand vs. Fargate Spot at runtime, and how to deploy each mode on ECS.

## Overview

- Capacity mode is set via environment variable and observed at runtime by both the web server and the SQS poller.
- On-demand tasks enable ECS Task Protection while work is active to avoid scale-in termination.
- Spot tasks avoid Task Protection and prioritize fast requeue on interruption to prevent data loss.

Key files

- Runtime capacity detection and task protection: `src/server.ts`
- SQS polling, autoscaling, and Spot drain logic: `src/sqsPoller.ts`

## Capacity mode detection (runtime)

The app derives capacity mode from the environment:

- `FARGATE_CAPACITY` or `FARGATE_CAPACITY_TYPE`:
  - `spot` → Spot mode
  - `on_demand`, `ondemand`, or `on-demand` → On-demand mode
  - anything else → `unknown`

In `src/server.ts`:

```ts
type FargateCapacityMode = 'on_demand' | 'spot' | 'unknown';
const rawCapacity = (process.env.FARGATE_CAPACITY || process.env.FARGATE_CAPACITY_TYPE || '').toLowerCase();
let fargateCapacityMode: FargateCapacityMode = rawCapacity === 'spot'
	? 'spot'
	: rawCapacity === 'on_demand' || rawCapacity === 'ondemand' || rawCapacity === 'on-demand'
	? 'on_demand'
	: 'unknown';

export function isSpotCapacity(): boolean { return fargateCapacityMode === 'spot'; }
```

## On-demand behavior (Fargate)

On on-demand, the app actively enables Task Protection during work to avoid scale-in while jobs are running.

Highlights in `src/server.ts`:

- Discovery of ECS identity (cluster/task) via ECS metadata API if not provided.
- `enableTaskProtection(durationMinutes = 60)` and `disableTaskProtection()`
- `manageTaskProtection()` keeps protection enabled whenever work is active (merging, downloading, etc.), with renewal coalescing (avoid thrashing when >10 minutes remain).
- `bumpProtectionIfOnDemand()` offers opportunistic renewals from other modules (e.g., poller).

Sketch:

```ts
if (!isSpotCapacity()) {
	// Protect task while work is active
	await enableTaskProtection(60);
}

// Periodically
await manageTaskProtection(); // enables or disables based on active job counts
```

Effect: While downloads/merges are in progress, the ECS service should not scale-in this task.

## Spot behavior (Fargate Spot)

On Spot, Task Protection has no effect; the code paths are no-ops. Instead, the app focuses on rapid requeue and graceful drain on interruption.

Highlights:

- SIGTERM handler checks Spot mode and triggers fast requeue.
- Poller exposes `requeueAllInFlightAndStop(visibilitySeconds)` and uses a small `SPOT_REQUEUE_VISIBILITY_SECONDS` (default 5s) to let other tasks pick up quickly.

In `src/server.ts` SIGTERM handler (conceptually):

```ts
process.on('SIGTERM', async () => {
	const isSpot = (process.env.FARGATE_CAPACITY || process.env.FARGATE_CAPACITY_TYPE || '').toLowerCase() === 'spot';
	if (isSpot) {
		// Ask the poller to requeue in-flight work quickly
		// (requeueAllInFlightAndStop lives in sqsPoller)
	}
	// Begin normal drain afterwards
});
```

In `src/sqsPoller.ts`:

- `SPOT_REQUEUE_VISIBILITY_SECONDS` (default 5)
- `requeueAllInFlightAndStop(visibilitySeconds)` to requeue all tracked jobs and stop polling

## SQS poller: concurrency, autoscaling, and long-running jobs

Highlights in `src/sqsPoller.ts`:

- Concurrency:
	- `MAX_CONCURRENT_JOBS` from env, or auto (`computeDefaultConcurrency('cpu')`) if not greedy-per-job.
	- `AUTOSCALE_JOBS` periodically adjusts max concurrency based on capacity unless overridden.
- Visibility extension:
	- For long downloads, `startVisibilityExtender(handle, 120, 900)` keeps messages invisible (extend every 120s up to 900s) to avoid premature retries.
- Fast requeue timeouts:
	- `REQUEUE_ON_TIMEOUT_SECONDS` (default 30) and Spot-specific `SPOT_REQUEUE_VISIBILITY_SECONDS` (default 5) influence retry timing.
- Idle behavior and polling:
	- `POLLING_INTERVAL_MS` (default 5000), `AUTO_EXIT_ON_IDLE` flag, and a small cap on `MAX_EMPTY_POLLS` for lightweight shutdowns.

Example capacity-aware polling:

```ts
// Only poll when capacity is available
if (!jobTracker.canAcceptMoreJobs()) return;
const availableCapacity = MAX_CONCURRENT_JOBS - jobTracker.count;
const maxMessages = Math.min(availableCapacity, 10);
```

## Deployment differences: on-demand vs. Spot

The Task Definition is the same for both. The difference is in the Service capacity provider strategy and the env var passed to the task.

1. On-demand only

```json
{
	"capacityProviders": ["FARGATE", "FARGATE_SPOT"],
	"defaultCapacityProviderStrategy": [
		{ "capacityProvider": "FARGATE", "base": 1, "weight": 1 }
	]
}
```

Set container env:

- `FARGATE_CAPACITY=on_demand`

2. Spot-preferred with on-demand fallback

```json
{
	"capacityProviders": ["FARGATE", "FARGATE_SPOT"],
	"defaultCapacityProviderStrategy": [
		{ "capacityProvider": "FARGATE_SPOT", "weight": 2 },
		{ "capacityProvider": "FARGATE", "weight": 1 }
	]
}
```

Set container env:

- `FARGATE_CAPACITY=spot`

Notes

- Use separate ECS services if you want strict separation (one on-demand, one Spot) and route traffic/queues accordingly.
- The app’s runtime behavior adapts solely from the env var; keep service strategy and env aligned.

## Quick references (code)

Enable protection on on-demand:

```ts
import { isSpotCapacity, enableTaskProtection, manageTaskProtection } from './src/server.js';

if (!isSpotCapacity()) {
	await enableTaskProtection(60);
}
await manageTaskProtection();
```

Requeue on Spot interruption:

```ts
import { requeueAllInFlightAndStop } from './src/sqsPoller.js';

process.on('SIGTERM', async () => {
	const isSpot = (process.env.FARGATE_CAPACITY || process.env.FARGATE_CAPACITY_TYPE || '').toLowerCase() === 'spot';
	if (isSpot) {
		await requeueAllInFlightAndStop(parseInt(process.env.SPOT_REQUEUE_VISIBILITY_SECONDS || '5', 10));
	}
});
```

## Environment variables

- Capacity mode: `FARGATE_CAPACITY` or `FARGATE_CAPACITY_TYPE` (`spot` | `on_demand`)
- SQS poller: `MAX_CONCURRENT_JOBS`, `POLLING_INTERVAL_MS`, `AUTOSCALE_INTERVAL_MS`, `AUTO_EXIT_ON_IDLE`
- Long jobs: `SQS_REQUEUE_ON_TIMEOUT_SECONDS`, `SPOT_REQUEUE_VISIBILITY_SECONDS`
- Shutdown: `SHUTDOWN_GRACE_MS`
- AWS/ECS: `AWS_REGION`, and ECS task metadata variables are discovered automatically if present

## Summary

- On-demand: enable Task Protection and keep it renewed while work is active.
- Spot: skip Task Protection, requeue fast on interruption, and drain quickly to minimize lost work.

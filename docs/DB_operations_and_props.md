# RDS transactions, ACID guarantees, and lock behavior

This document explains how our PostgreSQL (RDS) access layer is implemented in `src/lib/rdsService.ts`, how transactions are structured, how we achieve ACID properties, and what “lock out time” means in this codebase.

## Scope and goals

- Show how reads/writes are wrapped in transactions and when row-level locks are used.
- Map our implementation to ACID (Atomicity, Consistency, Isolation, Durability).
- Describe lock acquisition and “lock out time” (how long we wait vs fail fast) and the retry model.

## Connection model and configuration

RDS connections are created either as a single global client or via a connection pool:

- Single client: initialized by `initClient()`.
- Pool: initialized by `initPool()` and used when `usePool = true`.

Pool configuration (defaults shown when env vars are not set):

- max: `RDS_POOL_MAX` (default 20)
- idleTimeoutMillis: `RDS_IDLE_TIMEOUT` (default 30000 ms)
- connectionTimeoutMillis: `RDS_CONNECTION_TIMEOUT` (default 2000 ms)
- ssl: `{ rejectUnauthorized: false }`

Transport is encrypted (SSL). Text values are normalized and scrubbed with `sanitizeText()` before storage to avoid control chars and ensure consistent encoding.

## Write concurrency guard (in-process)

All write operations use a semaphore (`withSemaphore(dbSemaphore, 'db_write', …)`) to serialize DB writes within the process. This prevents local concurrent writers from interleaving and reduces lock contention at the database level. Cross-process contention is still handled by PostgreSQL locks and our retry logic.

## Transaction patterns used

We consistently open transactions with explicit isolation:

- `BEGIN ISOLATION LEVEL READ COMMITTED`

Operations are committed on success and rolled back on failure.

### 1) Store a new episode (idempotent, race-safe)

Method: `storeNewEpisodeWithRetry()` → `storeNewEpisodeInternal()`

High-level steps within a single transaction:

1. BEGIN (READ COMMITTED)
2. Duplicate checks inside the transaction to avoid races:
	- By `(episodeTitle, channelId)` using a SELECT with row-level lock
	- By `youtubeVideoId` when available, also locked
3. If duplicates are found, exit early; otherwise generate a new `episodeId`
4. INSERT into `public."Episodes"`
5. COMMIT

Key duplicate-check queries lock the candidate rows to make the check+insert atomic across concurrent workers:

```sql
SELECT "episodeId", "episodeTitle", "channelId", "channelName", "originalUri", "createdAt", "additionalData"
FROM public."Episodes"
WHERE "episodeTitle" = $1 AND "channelId" = $2 AND "deletedAt" IS NULL
ORDER BY "createdAt" DESC
LIMIT 1
FOR UPDATE NOWAIT;
```

and when checking by YouTube id:

```sql
SELECT "episodeId", "episodeTitle", "channelId", "channelName", "originalUri", "createdAt", "additionalData"
FROM public."Episodes"
WHERE "additionalData"->>'youtubeVideoId' = $1 AND "deletedAt" IS NULL
ORDER BY "createdAt" DESC
LIMIT 1
FOR UPDATE NOWAIT;
```

Notes:

- `FOR UPDATE` takes a row-level lock on the selected row for the duration of the transaction.
- `NOWAIT` makes the query fail immediately if the row is already locked (no waiting). This is central to our “lock out time” behavior; see below.

### 2) Update an episode (plus validation)

Methods: `updateEpisode()` → `updateEpisodeInternal()`

Steps:

1. BEGIN (READ COMMITTED)
2. Apply an UPDATE (fields are dynamically built from the provided `Partial<EpisodeRecord>`)
3. COMMIT
4. Independently validate persisted values using `validateEpisodeUpdate()`
5. If validation fails, the public method retries up to `RDS_UPDATE_VALIDATE_RETRIES` (default 3) with a base delay `RDS_UPDATE_VALIDATE_BASE_DELAY_MS` (default 200 ms) between attempts

This post-commit validation ensures the DB reflects exactly what was intended and protects against partial or out-of-order updates in concurrent scenarios.

### 3) Guest operations

`insertGuestInternal()` and `deleteGuestByNameInternal()` are also wrapped in `BEGIN … COMMIT` and execute atomically. They use the same retry surface as other writes.

## Automatic retry logic for transient conflicts

All writes go through `executeWithRetry(operation, maxRetries = 3, baseDelayMs = 100)`:

- Transient lock/contention errors and transaction-deadlocks are retried.
- Backoff grows with attempts (base delay configurable per call), keeping retries bounded.
- This combines with `FOR UPDATE NOWAIT` to avoid long server-side lock waits while still being resilient to brief contention spikes.

The public APIs that mutate data also run under the in-process semaphore noted above.

## ACID properties in practice

Our implementation is explicitly designed around PostgreSQL’s ACID guarantees:

- Atomicity
	- Every write path is executed within a single transaction (`BEGIN … COMMIT`), and errors trigger a rollback.
	- Duplicate detection and the subsequent insert happen within the same transaction to avoid races.

- Consistency
	- Inputs are sanitized with `sanitizeText()`.
	- Application-level invariants are enforced (e.g., no duplicate episodes per channel, `deletedAt IS NULL` filtering), and DB constraints apply.
	- After updates, `validateEpisodeUpdate()` re-reads the row and checks the fields provided, ensuring the write achieved the intended state.

- Isolation
	- We use `READ COMMITTED`, which prevents dirty reads.
	- Row-level locking via `SELECT … FOR UPDATE NOWAIT` ensures concurrent writers cannot both pass duplicate checks and insert the same logical record.
	- In PostgreSQL, `READ UNCOMMITTED` behaves the same as `READ COMMITTED`, so we explicitly use the latter for clarity.

- Durability
	- On COMMIT, PostgreSQL’s WAL durably persists changes. If the server crashes after commit, changes remain.
	- We connect over SSL to protect data in transit.

## Locking and “lock out time”

What is locked?

- When checking for duplicates, the candidate `Episodes` rows are locked with `FOR UPDATE` for the duration of the transaction. This prevents other concurrent transactions from modifying them in a way that would violate our uniqueness intent.

How long do we wait for locks?

- We use `NOWAIT` on those `FOR UPDATE` reads, so the database will not wait for a lock. If a row is locked by another transaction, our query fails immediately with a lock-not-available error. In practical terms, the lock wait time is 0 ms for these checks.

What happens on lock contention?

- The failure is handled by `executeWithRetry()`. We retry the whole operation up to `maxRetries` (default 3), with a base delay (default 100 ms) between attempts. This makes us resilient to brief contention without holding blocked sessions open.

Related client/pool timeouts that influence perceived “lock out time” on the application side:

- `connectionTimeoutMillis` (default 2000 ms): If a pooled client cannot be acquired within this time, acquiring a connection fails.
- `idleTimeoutMillis` (default 30000 ms): How long idle clients stay in the pool before being closed (not a lock wait, but pool hygiene).
- Update validation retries: `RDS_UPDATE_VALIDATE_RETRIES` (default 3) with `RDS_UPDATE_VALIDATE_BASE_DELAY_MS` (default 200 ms) between attempts governs how long we’re willing to wait to observe the expected state after a write.

No explicit `statement_timeout` is set in code; we rely on the database’s defaults for query execution timeouts.

## Read patterns

Reads like `getEpisode()` and `getGuestByName()` are simple SELECTs outside of long-lived transactions. For existence checks that must be race-safe (preceding an insert), we perform them inside a transaction and add row locks as shown above.

## Quick reference

- Isolation level: READ COMMITTED
- Duplicate checks: SELECT … FOR UPDATE NOWAIT (fail fast on lock)
- In-process write guard: `withSemaphore(dbSemaphore, 'db_write', …)`
- Retry helper: `executeWithRetry()` (default 3 attempts, base 100 ms)
- Post-write validation: `validateEpisodeUpdate()` with configurable retry/delay

## See also

- Source: `src/lib/rdsService.ts`
- End-to-end flow: `docs/Guide_to_understanding_to_process.md`
- HLS processing: `docs/MP4_TO_HLS.md`
- ECS runtime behavior: `docs/ECS_OPTIMIZATIONS.md`

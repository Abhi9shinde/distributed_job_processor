# Distributed Job Processor: Project File Guide

This document explains the project-maintained files in the repository: why each
file exists, what it contains, and how it participates in the distributed job
processing flow.

The guide focuses on source code, configuration, database migrations,
documentation, and tests. It does not describe every file under `node_modules`,
generated Prisma output, build output, editor caches, or tool caches because
those files are produced by dependencies or commands rather than maintained as
application source.

## 1. What the project does

The application accepts jobs through an Express API and stores each job and its
transactional outbox event in PostgreSQL. A continuous outbox publisher claims
pending events and places them into a BullMQ queue backed by Redis. Independent
workers consume queue jobs, track processing attempts, renew processing leases,
record an idempotent business effect, and update the durable PostgreSQL job
state.

The main delivery path is:

```text
HTTP request
  -> PostgreSQL Job + OutBoxEvent transaction
  -> outbox publisher claims the event
  -> Redis/BullMQ
  -> worker claims a processing attempt
  -> idempotent business effect
  -> PostgreSQL COMPLETED, RETRYING, or FAILED state
```

The system is designed for at-least-once delivery. A job may be executed more
than once, but the `JobEffect` unique idempotency key prevents the simulated
business effect from being recorded more than once.

## 2. Repository-level files

### `README.md`

This is the project's introductory and architectural document. It explains the
system at a high level, including:

- The API, PostgreSQL, transactional outbox, Redis/BullMQ, workers, and
  recovery process.
- The job state machine.
- At-least-once delivery and idempotent effects.
- Publisher and worker failure handling.
- Available API endpoints.
- Local setup and process commands.

The README is intended for someone encountering the repository for the first
time. This file is a more detailed companion reference for the implementation
of each project file.

### `package.json`

This is the Node.js project manifest.

It defines:

- The package name and version.
- ESM mode through `"type": "module"`.
- Runtime dependencies:
  - Express for the HTTP API.
  - Prisma and the PostgreSQL adapter for database access.
  - BullMQ and ioredis for queue processing.
  - Zod for request validation.
  - dotenv for environment loading.
- Development dependencies:
  - TypeScript and `tsx`.
  - Vitest and Supertest.
  - ESLint and Prettier.

Important scripts:

- `npm run dev`: starts the API with `tsx watch`.
- `npm run build`: type-checks and emits TypeScript into `dist`.
- `npm start`: runs the compiled API.
- `npm test`: runs Vitest serially to avoid integration-test interference.
- `npm run test:watch`: starts Vitest in watch mode.
- `npm run lint`: runs ESLint.
- `npm run format`: formats the repository.
- `npm run format:check`: checks formatting without changing files.
- `npm run check`: runs the build and lint checks.
- `npm run test:db`: checks that Prisma can connect to PostgreSQL.
- `npm run worker`: starts the BullMQ worker process.
- `npm run outbox:publish`: starts the continuous outbox publisher.
- `npm run recovery`: starts the expired-processing-job recovery process.

### `package-lock.json`

This is npm's lockfile. It records exact dependency versions and the resolved
package sources so installs are repeatable. It should be updated when
`package.json` dependencies change and should normally be committed with the
manifest.

### `tsconfig.json`

This is the TypeScript compiler configuration.

It:

- Targets ES2022.
- Uses Node's ESM-compatible `NodeNext` module settings.
- Treats `src` as the source root.
- Emits compiled files to `dist`.
- Enables strict type checking.
- Enables `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` for stricter code.
- Emits source maps and declarations.
- Stops emission when errors exist.
- Includes `src/**/*.ts` and excludes tests, dependencies, and build output.

### `vitest.config.ts`

This configures Vitest to run with:

- One worker.
- No file-level parallelism.

The setting reduces interference between integration tests that share
PostgreSQL and Redis resources.

### `eslint.config.mjs`

This is the flat ESLint configuration.

It:

- Ignores `dist`, `node_modules`, and `coverage`.
- Enables the recommended JavaScript rules.
- Enables the recommended TypeScript ESLint rules.
- Treats unused variables as errors, while allowing names beginning with `_`
  for intentionally unused arguments or variables.

### `.env.example`

This documents the environment variables expected by local development:

- `DATABASE_URL`: PostgreSQL connection string used by Prisma.
- `TEST_DATABASE_URL`: optional test database variable.
- `REDIS_HOST`: Redis hostname, defaulting in code to `127.0.0.1`.
- `REDIS_PORT`: Redis port, defaulting in code to `6379`.
- `PORT`: HTTP server port, defaulting in the server to `3000`.

The file contains placeholders rather than credentials. A real `.env` file
should not be committed.

### `docker-compose.yml`

This defines local infrastructure:

- PostgreSQL 17 in the `job-processor-postgres` container.
- Redis 7 in the `redis` container.
- Persistent Docker volumes for both services.
- PostgreSQL health checks using `pg_isready`.
- Redis append-only persistence.
- Local ports `5432` and `6379`.

It is intended for development and integration testing. The application
processes itself run through npm scripts rather than as Compose services.

### `redis-backup.rdb`

This is a Redis snapshot file. It is runtime data rather than application
source. It may contain queue state from a local Redis instance and should not be
treated as part of the application design or committed if it contains
environment-specific data.

## 3. Prisma configuration and database files

### `prisma.config.ts`

This configures Prisma CLI operations.

It:

- Loads environment variables through dotenv.
- Uses `prisma/schema.prisma` as the schema.
- Uses `prisma/migrations` for migrations.
- Reads `DATABASE_URL` through Prisma's environment helper.

### `prisma/schema.prisma`

This is the source of truth for the application data model.

#### `JobStatus`

The job lifecycle states are:

- `QUEUED`: persisted but not yet actively processing.
- `PROCESSING`: owned by a worker attempt.
- `RETRYING`: eligible to be published and processed again.
- `COMPLETED`: processing finished successfully.
- `FAILED`: all configured queue attempts were exhausted or the job failed
  permanently.

#### `OutBoxStatus`

Outbox events are either:

- `PENDING`: waiting to be claimed and published.
- `PUBLISHED`: successfully handed to BullMQ.

#### `Job`

The `Job` model stores the durable application-level job:

- `id`: primary key generated with `cuid()`.
- `type`: identifies the kind of job.
- `payload`: JSON input for the job.
- `status`: current lifecycle state.
- `attempts`: application processing-attempt count.
- `maxAttempts`: maximum retry setting copied into queue configuration.
- `createdAt` and `updatedAt`: timestamps.
- `outboxEvents`: relation to the job's outbox records.
- `currentAttemptId`: ownership token for the current worker attempt.
- `processingLeaseExpiresAt`: deadline used to detect a crashed worker.
- `lastError`: latest worker error message.

The composite index on `status` and `processingLeaseExpiresAt` supports
finding expired processing jobs.

#### `OutBoxEvent`

This model is the transactional outbox:

- `jobId`: related job and foreign key.
- `eventType`: event name sent to BullMQ.
- `payload`: queue payload.
- `status`: pending or published.
- `attempts`: publisher-attempt count, separate from job attempts.
- `lastError`: most recent publisher error.
- `createdAt`, `updatedAt`, and `publishedAt`: event timing.
- `claimToken`: unique ownership token for a publisher lease.
- `claimedUntil`: publisher lease expiration time.

The indexes support status/time scans and lookup by job. The foreign key uses
`ON DELETE CASCADE`, so deleting a job deletes its outbox events.

#### `IdempotencyRecord`

This stores the result of an idempotent operation. Its unique
`idempotencyKey` prevents duplicate records for the same logical operation.

#### `JobEffect`

This represents the simulated business effect. Its unique `idempotencyKey`
ensures that concurrent or repeated processing records one effect only.

## 4. Database migrations

The migration directory is append-only schema history. Prisma applies these
migrations in timestamp order.

### `prisma/migrations/20261024133411_init/migration.sql`

Creates the initial `Job` table and the initial `JobStatus` enum with
`QUEUED`, `PROCESSING`, `COMPLETED`, and `FAILED`.

### `prisma/migrations/20261025172811_add_transactional_outbox/migration.sql`

Creates the `OutBoxStatus` enum and `OutBoxEvent` table. It adds indexes for
pending-event ordering and job lookup, then adds the foreign key from outbox
events to jobs.

### `prisma/migrations/20261026061215_add_outbox_claim_lease/migration.sql`

Adds `claimToken` and `claimedUntil` to `OutBoxEvent`, enabling lease-based
publisher ownership and recovery after a publisher crash.

### `prisma/migrations/20261026135224_add_idempotency_record/migration.sql`

Creates `IdempotencyRecord` and its unique idempotency-key index.

### `prisma/migrations/20261026141215_add_job_effect/migration.sql`

Creates `JobEffect` and its unique idempotency-key index.

### `prisma/migrations/20261027102748_add_retrying_job_status/migration.sql`

Adds the `RETRYING` value to `JobStatus`.

### `prisma/migrations/20261027162124_add_current_attempt_id/migration.sql`

Adds `currentAttemptId` to `Job` so completion and failure updates can verify
that the worker still owns the attempt.

### `prisma/migrations/20261028143402_add_job_processing_lease/migration.sql`

Adds `processingLeaseExpiresAt` and its status/time index. This supports
detecting jobs whose workers stopped renewing their processing lease.

### `prisma/migrations/20261029132408_add_job_last_error/migration.sql`

Adds `lastError` to `Job` so the API can expose the latest worker failure and
manual retry can clear it.

### `prisma/migrations/migration_lock.toml`

This is Prisma's migration-provider lock file. It records PostgreSQL as the
database provider and should not be edited manually.

## 5. API files

### `src/api/app.ts`

Builds and exports the Express application without starting a network server.

It:

- Enables JSON request parsing.
- Mounts the job router at `/jobs`.
- Mounts the health router at `/health`.
- Provides a simple `/health` response.

Keeping the app separate from `listen()` makes it easy for Supertest to test
routes without opening a real port.

### `src/api/server.ts`

This is the HTTP entry point. It imports the Express app, chooses `PORT` or
`3000`, and starts listening.

### `src/api/routes/job.ts`

This router exposes job creation, retrieval, and manual retry.

#### `POST /jobs`

The Zod schema requires:

- A trimmed non-empty `type` with a maximum length of 100.
- A JSON-compatible object `payload`.

After validation, a Prisma transaction:

1. Creates a `Job` in `QUEUED` state.
2. Creates a matching `JOB_CREATED` `OutBoxEvent`.
3. Commits both records together.

The endpoint returns `201` with the created job. Invalid input returns `400`;
unexpected database errors are logged and return `500`.

The commented-out direct BullMQ code shows an earlier design that was replaced
by the transactional outbox. It is not executed.

#### `GET /jobs/:id`

Looks up one job by ID. It returns:

- `200` with the job if found.
- `404` if no job exists.
- `500` for an unexpected database error.

#### `POST /jobs/:id/retry`

Manually retries only a `FAILED` job inside a transaction:

1. Looks up the job.
2. Returns a typed result for not-found or wrong-state cases.
3. Conditionally changes `FAILED` to `RETRYING`.
4. Resets `attempts` to zero.
5. Clears `lastError`.
6. Creates a fresh outbox event.

It returns `404` for a missing job, `409` for a job that is not failed, and
`202` after the retry event is durably queued in PostgreSQL.

The conditional `updateMany` is used as an optimistic concurrency check:
another request can change the state between the read and update, in which
case the update count is zero and no new outbox event is created.

### `src/api/routes/health.ts`

Provides readiness and liveness checks.

- `GET /health/live` always returns an application liveness response.
- `GET /health/ready` checks PostgreSQL with `SELECT 1` and waits for the
  BullMQ queue to be ready.

Readiness returns `200` only when both checks pass; otherwise it returns `503`
with individual `postgres` and `redis` booleans.

### `src/api/routes/health-check.ts`

Exports `checkWithTimeout`, a small reusable health-check helper.

It races the supplied asynchronous check against a two-second timer. It
returns `true` for a successful check and `false` for an exception or timeout.
The timer is cleared in `finally`.

## 6. Database runtime files

### `src/db/prisma.ts`

Creates the shared Prisma client:

1. Loads dotenv.
2. Requires `DATABASE_URL`.
3. Creates a PostgreSQL adapter with `PrismaPg`.
4. Exports one `PrismaClient` instance for application modules.

Failing fast when `DATABASE_URL` is absent prevents the application from
starting with an invalid database configuration.

### `src/db/check-connection.ts`

This diagnostic script explicitly connects to PostgreSQL, counts jobs, prints
the result, and disconnects. It is run with `npm run test:db`.

### `src/db/diagnose-connection.ts`

Runs ten `SELECT 1` queries and prints each duration. It is useful for
observing connection or database latency during local performance testing.

## 7. Queue and outbox files

### `src/queue/job-queue.ts`

Creates and exports the BullMQ `jobs` queue. Redis host and port come from the
environment with local defaults.

The queue object is shared by the publisher, health endpoint, and tests.

### `src/outbox/claim-events.ts`

Claims pending outbox events for one publisher instance.

The function:

1. Generates a unique UUID claim token.
2. Starts a Prisma transaction.
3. Selects up to 50 pending or expired-claim events.
4. Orders them by creation time.
5. Uses PostgreSQL `FOR UPDATE SKIP LOCKED` so concurrent publishers do not
   wait on or select the same locked rows.
6. Updates the selected rows with the token and a 30-second lease.
7. Returns the event data and token.

The token and lease make publisher ownership explicit. If a publisher stalls,
another publisher can reclaim the event after `claimedUntil`.

### `src/outbox/publisher.ts`

Publishes claimed outbox events to BullMQ.

It:

1. Claims a batch.
2. Reloads the events while verifying their claim token.
3. Publishes events in groups of ten concurrent operations.
4. Uses `outbox-${event.id}` as the stable BullMQ job ID.
5. Configures BullMQ retry attempts and exponential backoff from the job.
6. Marks the event `PUBLISHED` only when the database update still matches
   the claim token.
7. Records publisher errors and releases the claim if queue insertion fails.

The conditional publication update prevents a stale publisher from clearing
another publisher's lease. A queue insert can succeed before the database
update; the stable queue job ID makes that crash window recoverable through
BullMQ deduplication.

The file also contains the previous serial publisher implementation as
commented-out code. The active implementation publishes ten events
concurrently.

### `src/outbox/run-publisher.ts`

Runs the publisher continuously.

It:

- Runs one cycle immediately.
- Runs another cycle every 500 milliseconds.
- Uses `isRunning` to avoid overlapping cycles in the same process.
- Uses `isShuttingDown` to prevent new work during shutdown.
- Stops the interval on `SIGINT` or `SIGTERM`.
- Waits for an active cycle to finish.
- Disconnects Prisma after processing stops.

### Outbox lifecycle

The API creates `PENDING` events. The publisher claims them, sends them to
BullMQ, and changes them to `PUBLISHED`. If the publisher crashes during the
process, the lease expires and another publisher can retry. If Redis insertion
fails, the event remains pending, records the error, and releases its claim.

## 8. Worker files

### `src/worker/index.ts`

This is the production BullMQ worker entry point.

For each queue job it:

1. Reads `jobId`, `type`, and `payload`.
2. Calls `startJobAttempt`.
3. Skips processing if the job is not in a claimable database state.
4. Calls `handleJob` with the attempt ID and BullMQ retry information.

It also logs completed and failed queue jobs and installs graceful shutdown
handlers. The commented-out shutdown and failure-handling blocks are older
implementations; the active logic is in the imported modules.

### `src/worker/start-job-attempt.ts`

Starts one database-owned processing attempt.

It creates a random attempt ID and conditionally updates a job only when:

- The job is `QUEUED` or `RETRYING`.
- `currentAttemptId` is null.

The update changes the job to `PROCESSING`, increments `attempts`, stores the
attempt ID, and creates a 60-second processing lease.

Returning `null` when the update count is zero prevents two workers from
claiming the same database job.

### `src/worker/handle-job.ts`

Coordinates one worker attempt.

It:

1. Starts a heartbeat interval every 20 seconds.
2. Renews the processing lease using the attempt ID.
3. Marks the attempt as lost if renewal fails.
4. Calls `processJobIdempotently`.
5. Refuses to complete processing after losing the lease.
6. Conditionally changes the job to `COMPLETED`.
7. Clears the attempt ID, processing lease, and old error on success.
8. Delegates failures to `handleJobFailure`.
9. Always stops the heartbeat in `finally`.

The completion update checks both the job status and `currentAttemptId`, so a
stale worker cannot complete a newer attempt.

### `src/worker/renew-processing-lease.ts`

Extends the current attempt's processing lease by 60 seconds. It requires the
matching job ID, attempt ID, and `PROCESSING` status. Its boolean result tells
the heartbeat whether ownership still exists.

### `src/worker/handle-job-failure.ts`

Persists a worker failure using a conditional update.

It:

- Computes `RETRYING` or `FAILED` from BullMQ's attempt count and maximum.
- Requires the current attempt ID and `PROCESSING` state.
- Clears attempt ownership and the processing lease.
- Stores the error message in `lastError`.
- Logs whether retry remains or attempts are exhausted.

A stale worker's failure update affects zero rows and cannot overwrite a newer
attempt.

### `src/worker/process-job.ts`

Contains the simulated business operation.

It uses `job:${jobId}` as the idempotency key and runs the effect plus
idempotency record creation in one transaction. If an effect already exists,
it returns an `already_processed` result. If a concurrent insert wins a unique
constraint race, it reloads the existing effect and returns the same result.

This is the main demonstration of at-least-once delivery with an idempotent
effect.

### `src/worker/recover-expired-jobs.ts`

Finds up to ten `PROCESSING` jobs whose lease has expired and moves each to
`RETRYING`.

For every candidate it conditionally verifies:

- The job ID.
- The original `PROCESSING` state.
- The original attempt ID.
- An expired lease.

When the update succeeds, it creates a new outbox event in the same
transaction. This prevents a worker that lost ownership from recovering a
newer attempt and ensures the recovered job is sent back through the normal
outbox path.

The file retains an older commented-out implementation that changed status
without creating a new outbox event. The active implementation includes the
outbox creation.

### `src/worker/run-recovery.ts`

Runs expired-job recovery continuously.

It:

- Runs once at startup.
- Runs every ten seconds.
- Prevents overlapping recovery cycles.
- Logs the number of recovered jobs.
- Stops scheduling on shutdown.
- Waits for an active recovery cycle.
- Disconnects Prisma after shutdown.

### `src/worker/graceful-shutdown.ts`

Exports a reusable shutdown factory. The caller supplies:

- `stopProcessing`: stop accepting new work and wait for active work.
- `disconnectDatabase`: close Prisma.

The returned function handles repeated signals, logs progress, sets the process
exit code on failure, and disconnects the database only after processing has
stopped.

## 9. Unit tests

### `tests/unit/health-check.test.ts`

Tests the timeout helper's basic behavior:

- A successful check returns true.
- A rejected check returns false.
- A check that exceeds the timeout returns false.

### `tests/unit/graceful-shutdown.test.ts`

Tests shutdown orchestration:

- Processing stops before the database disconnects.
- A repeated shutdown signal does not run shutdown twice.
- A processing-stop failure is logged and prevents the database disconnect
  from running.

## 10. Integration tests

### `tests/integration/health.test.ts`

Tests liveness and readiness HTTP responses:

- Liveness returns `200`.
- Both PostgreSQL and Redis ready returns `200`.
- PostgreSQL failure returns `503`.
- Redis failure returns `503`.
- Both failures return `503`.

Prisma and BullMQ readiness calls are mocked so the route states can be tested
without requiring every dependency to be healthy.

### `tests/integration/job.test.ts`

Tests the jobs API:

- Valid creation returns `201`.
- Invalid input returns `400`.
- Existing job lookup returns `200`.
- Missing job lookup returns `404`.
- Manual retry changes a failed job to `RETRYING` and creates an outbox event.
- Completed jobs cannot be manually retried.
- Missing jobs return `404` for retry.
- A zero-row conditional retry update does not create an outbox event.

The file uses Vitest mocks for Prisma and the queue to test route behavior
without starting the full infrastructure.

### `tests/integration/job-failure.test.ts`

Tests worker failure state transitions:

- A failure with retries remaining becomes `RETRYING`.
- The current attempt and processing lease are cleared.
- An exhausted job becomes `FAILED`.
- `lastError` is persisted.
- A stale attempt cannot overwrite the current attempt.

### `tests/integration/idempotency.test.ts`

Tests the idempotent effect function:

- Reprocessing the same job creates one effect.
- Concurrent processing creates one effect.
- A conflicting idempotency record rolls back the effect transaction.

### `tests/integration/worker-idempotency.test.ts`

Tests the duplicate-effect scenario that occurs when a job is retried after
the business effect succeeds but before job completion is persisted.

### `tests/integration/worker-handler.test.ts`

Tests the complete handler retry path:

- A first attempt records the effect.
- A simulated completion-state problem is followed by a retry.
- The second attempt returns `already_processed`.
- Only one effect and one idempotency record exist.
- Concurrent `startJobAttempt` calls allow only one worker to claim the job.

### `tests/integration/bullmq-retry-lifecycle.test.ts`

Starts a temporary BullMQ queue and worker. It simulates a first-attempt
failure, allows BullMQ to retry, and verifies:

- Two processor attempts occur.
- The database job completes.
- The effect and idempotency record exist once.

### `tests/integration/bullmq-dedup.test.ts`

Tests BullMQ job IDs:

- Adding the same job ID twice does not create two stored queue jobs.
- Removing the first job allows the same ID to be added again.

### `tests/integration/outbox-claim.test.ts`

Tests outbox concurrency:

- Two concurrent claim calls do not overlap.
- Twelve events are divided between the two claimers.
- An expired lease can be reclaimed with a new claim token.
- The recovered event receives a future lease deadline.

### `tests/integration/outbox-lease-reclaim.test.ts`

Tests publisher crash-window behavior:

- An event is published to BullMQ.
- Its database claim is made expired.
- Another publisher reclaims it.
- The stable BullMQ ID prevents duplicate queue jobs.
- The stale publisher cannot mark the event published with its old token.

### `tests/integration/worker-expired-job-recovery.test.ts`

Tests expired processing recovery:

- Expired jobs become `RETRYING`.
- Active leases remain untouched.
- A recovered event can go through the outbox publisher and worker to
  completion.
- The business effect is recorded once.
- A manually failed job can be retried through the API, outbox, and BullMQ.

### `tests/integration/worker-lease-renewal.test.ts`

Tests that:

- The current attempt can renew an expired lease.
- A stale attempt cannot renew a lease owned by another attempt.

### `tests/integration/worker-shutdown.test.ts`

Starts a temporary worker with a blocked job and verifies that closing the
worker waits for the active job to finish.

## 11. Existing documentation

### `docs/decisions/001-stack-selection.md`

This architecture decision record explains why the project uses:

- Node.js and TypeScript.
- Express.
- PostgreSQL.
- Redis and BullMQ.
- Docker Compose.
- Vitest and Supertest.

It records alternatives such as native HTTP, a custom Redis queue, and an
in-memory queue, along with the operational consequence that Redis must be
monitored and operated.

### `docs/testing`

This directory exists for testing-related documentation. It is currently
empty, so the automated testing details are currently represented by the test
files and npm scripts instead.

## 12. Runtime commands and process roles

For local development, the infrastructure and application processes have
separate responsibilities:

```powershell
docker compose up -d
npm run dev
npm run outbox:publish
npm run worker
npm run recovery
```

- The API accepts and reads jobs.
- The outbox publisher moves durable events into BullMQ.
- The worker executes queue jobs.
- The recovery process requeues jobs whose processing leases expired.

The default local ports are:

- API: `3000`.
- PostgreSQL: `5432`.
- Redis: `6379`.

## 13. Important state and ownership concepts

### Outbox claim ownership

`claimToken` and `claimedUntil` identify the publisher that currently owns an
outbox event. A stale publisher must include its old token in the update, so it
cannot clear a newer publisher's lease.

### Worker attempt ownership

`currentAttemptId` identifies the worker attempt that owns a processing job.
Completion, failure, and lease renewal all require the matching attempt ID.

### Processing lease

`processingLeaseExpiresAt` is renewed by the active worker. If it expires,
`run-recovery.ts` eventually moves the job back to `RETRYING` and creates a new
outbox event.

### Idempotent effect

The unique key `job:${jobId}` ensures that repeating a job does not repeat the
simulated effect. The database transaction protects both the effect and its
idempotency record.

## 14. Files intentionally not documented individually

The repository also contains generated or external files that should not be
manually maintained as application logic:

- `node_modules/`: installed third-party packages.
- `dist/`: TypeScript build output when generated.
- `src/generated/prisma/`: generated Prisma client output.
- `.vite/`, `.vitest-cache/`, and coverage directories: tool caches/output.
- Editor and operating-system metadata.

These are derived from maintained files and commands. If generated output
appears in version control, it should be handled according to the project's
chosen Git policy rather than edited directly.

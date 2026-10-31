# Testing Guide

This document explains how to run and reason about the test suite for
the Distributed Job Processor.

The project uses **Vitest** as its test runner and **Supertest** for
HTTP-level tests. Tests cover API behaviour, database-backed job
workflows, BullMQ integration, worker reliability, and selected utility
functions.

## Test commands

Run the complete test suite:

``` bash
npm test
```

Run tests in watch mode during development:

``` bash
npm run test:watch
```

Run the TypeScript build and ESLint checks:

``` bash
npm run check
```

`npm run check` runs:

``` bash
npm run build && npm run lint
```

A successful `npm run check` does not replace the test suite. Run both
`npm test` and `npm run check` before considering a change verified.

## Test infrastructure

The integration tests use the project's database and queue
infrastructure. Start the local services with:

``` bash
docker compose up -d
```

Configure the test database connection through `TEST_DATABASE_URL` in
`.env`, if the test configuration requires a separate database. Keep
test data isolated from any database containing data you need to
preserve.

The project also uses Redis for BullMQ integration. Use the Redis
instance configured by `REDIS_HOST` and `REDIS_PORT`.

Before running tests, make sure the required database schema is up to
date:

``` bash
npx prisma generate
npx prisma migrate deploy
```

Use the test database for test runs. Do not point destructive test setup
or cleanup at a database containing important data.

## Important: stop application processes before integration tests

The API, worker, continuous outbox publisher, and expired-job recovery
process can all interact with the same PostgreSQL database and Redis
queue used by integration tests.

Before running the full integration suite, stop any manually started
application processes:

-   API: `npm run dev`
-   Worker: `npm run worker`
-   Outbox publisher: `npm run outbox:publish`
-   Recovery process: `npm run recovery`

Keep the Docker PostgreSQL and Redis services running.

This matters because a live worker can consume a BullMQ job created by a
test before the test has finished asserting or cleaning it up. That can
cause race conditions, locked-job cleanup errors, or non-deterministic
results. The test suite should control the queue during integration
tests.

The project's Vitest script runs with one worker and disables file
parallelism:

``` json
"test": "vitest run --maxWorkers=1 --no-file-parallelism"
```

This serial execution reduces interference between tests that share
database and queue resources. Do not remove this setting without first
reviewing test isolation and shared-resource behaviour.

## What the tests cover

The suite contains unit and integration tests. The test files include
the following areas:

  -----------------------------------------------------------------------
  Area                                Test coverage
  ----------------------------------- -----------------------------------
  Health checks                       Health endpoint and health-check
                                      behaviour

  Job API                             Job route behaviour and request
                                      handling

  Outbox claiming                     Claiming pending events and claim
                                      ownership

  BullMQ deduplication                Stable queue job IDs and duplicate
                                      prevention

  Idempotency                         Preventing duplicate job effects

  Worker handling                     Job execution and worker behaviour

  Job failure                         Failure state transitions and retry
                                      lifecycle

  Worker shutdown                     Graceful worker shutdown behaviour

  Outbox lease recovery               Reclaiming stale claims and
                                      handling the publisher crash window

  Lease renewal                       Extending a job's processing lease

  Expired-job recovery                Recovering jobs whose processing
                                      leases have expired

  Manual retry                        Concurrent manual retry requests
                                      and retry workflow

  Graceful shutdown utility           Unit tests for shared shutdown
                                      behaviour
  -----------------------------------------------------------------------

The suite has previously passed with **44 tests across 15 test files**.
Treat the output from the current checkout as the source of truth if
tests are added, removed, or changed.

## Recommended verification workflow

For a change to application code:

1.  Read the relevant tests before changing the implementation.

2.  Make the smallest change that addresses the requirement.

3.  Run the relevant test file while developing, where practical:

    ``` bash
    npx vitest run tests/path/to/example.test.ts
    ```

4.  Run the complete suite:

    ``` bash
    npm test
    ```

5.  Run the build and lint checks:

    ``` bash
    npm run check
    ```

6.  Review the final Git diff to ensure the change did not introduce
    unrelated modifications.

Before a final project handoff, run both `npm test` and `npm run check`
with the application processes stopped and the required test
infrastructure available.

## Reliability scenarios worth preserving

The following tests exercise important distributed-systems failure cases
and should remain part of the suite:

-   A publisher with an expired claim must not overwrite a newer
    publisher's claim.
-   If a publisher adds an event to BullMQ and crashes before marking
    the outbox event as published, a subsequent attempt should use the
    stable queue job ID to avoid creating a second retained queue job.
-   A stale worker attempt must not overwrite state owned by a newer
    attempt.
-   An expired processing lease should allow eligible work to be
    recovered.
-   Concurrent manual retry requests should not create multiple retry
    events for the same failed job.
-   Repeated delivery should not create duplicate effects when the
    idempotency mechanism is applied.

These tests validate at-least-once delivery and idempotent effects. They
do **not** establish exactly-once execution.

## Troubleshooting

### A test fails while an application worker is running

Stop the worker, publisher, recovery process, and API, then rerun the
test suite. A live worker may consume test jobs from the shared BullMQ
queue and interfere with test assertions or cleanup.

### A test cannot connect to PostgreSQL or Redis

Check that Docker services are running:

``` bash
docker compose ps
```

Check the `.env` values for `TEST_DATABASE_URL`, `REDIS_HOST`, and
`REDIS_PORT`. Confirm that migrations have been applied to the test
database.

### A test fails during queue cleanup

Check whether another process is consuming or holding the test queue's
jobs. Stop all application processes that use the `jobs` queue and rerun
the tests.

## Scope and limitations

This guide documents the current Vitest-based test workflow and the test
scenarios known from the project. It does not claim that every possible
infrastructure failure, concurrency level, or production deployment
condition has been tested.

Load testing and broad fault-injection testing are not prerequisites in
the current finalization checklist. Any performance figures should
identify the workload and measurement method, and API enqueue throughput
must not be described as completed-job throughput.

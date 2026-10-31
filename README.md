# Distributed Job Processor

A distributed background job processing system built with **Node.js, TypeScript, Express, PostgreSQL, Prisma, Redis, and BullMQ**.

The system accepts jobs through an HTTP API, persists them in PostgreSQL, reliably publishes them to Redis through the Transactional Outbox Pattern, and processes them using independently running worker processes.

The project focuses on distributed systems fundamentals: reliable event publishing, idempotent processing, retries, lease-based recovery, concurrency control, and graceful shutdown.

## Architecture

```mermaid
flowchart TB
    Client[Client]
    API[Express API]
    DB[(PostgreSQL)]
    Outbox[Outbox Publisher]
    Redis[(Redis / BullMQ)]
    Worker[Worker Processes]
    Recovery[Expired Job Recovery]

    Client --> API
    API -->|Transaction: Job + Outbox Event| DB
    Outbox -->|Claim pending events| DB
    Outbox -->|Publish events| Redis
    Redis -->|Deliver jobs| Worker
    Worker -->|Update job state and effects| DB
    Recovery --->|Recover expired jobs| DB
    Recovery -->|Create new outbox events| DB
```

### Core Components

| Component            | Responsibility                                                               |
| -------------------- | ---------------------------------------------------------------------------- |
| API                  | Accepts job submissions, retrieves job status, and supports manual retries   |
| PostgreSQL           | Persistent storage for jobs, outbox events, idempotency records, and effects |
| Transactional Outbox | Ensures job creation and event creation happen in one database transaction   |
| Outbox Publisher     | Claims pending events and publishes them to BullMQ                           |
| Redis / BullMQ       | Queue storage, job delivery, retries, and backoff                            |
| Workers              | Execute jobs independently of the API process                                |
| Recovery Process     | Detects expired processing leases and recovers abandoned jobs                |

## Features

- **Transactional Outbox Pattern:** Job records and corresponding outbox events are committed atomically.
- **Independent Workers:** API and background workers run as separate processes.
- **At-Least-Once Delivery:** Supports reliable event publication with recovery from publisher failures.
- **Idempotent Processing:** Uses database-backed idempotency records and unique constraints to prevent duplicate effects.
- **Automatic Retries:** Configurable retry attempts with exponential backoff through BullMQ.
- **Manual Job Retry:** Failed jobs can be retried through an API endpoint.
- **Lease-Based Job Recovery:** Detects jobs abandoned by crashed or disconnected workers.
- **Outbox Lease Management:** Uses claim tokens and lease expiration to support safe concurrent publishing and recovery.
- **Lease Renewal:** Workers periodically renew processing leases while jobs are running.
- **Graceful Shutdown:** Shared shutdown handling allows processes to stop accepting new work and finish in-flight operations.
- **Concurrent Claiming:** PostgreSQL `FOR UPDATE SKIP LOCKED` prevents competing publishers from claiming the same available events simultaneously.

## Job Lifecycle

```mermaid
stateDiagram-v2
    [*] --> QUEUED
    QUEUED --> PROCESSING
    PROCESSING --> COMPLETED
    PROCESSING --> RETRYING: Processing failure
    RETRYING --> PROCESSING
    RETRYING --> FAILED: Attempts exhausted
    FAILED --> RETRYING: Manual retry
    COMPLETED --> [*]
```

A job is first persisted in PostgreSQL. Its outbox event is then published to BullMQ, where a worker picks it up for processing.

The worker atomically claims the job, executes its operation, and records the result. If processing fails, the job follows the configured retry lifecycle.

## Transactional Outbox Workflow

1. The API receives a job submission.
2. A database transaction creates both the job and its outbox event.
3. The publisher claims pending events using a unique claim token and lease.
4. The event is published to BullMQ using a stable queue job ID.
5. The publisher marks the event as published.
6. If the publisher crashes between queue publication and the database update, the event can be reclaimed. The stable BullMQ job ID helps prevent duplicate queue entries while the original queue job is retained.

This design addresses the database-to-queue dual-write problem without requiring a distributed transaction.

## Reliability and Failure Handling

### Publisher Recovery

- Claim tokens prevent stale publishers from updating events they no longer own.
- Expired leases allow abandoned claims to be reclaimed.
- Stable BullMQ job IDs help handle the crash window between queue publication and outbox acknowledgement.

### Worker Recovery

- Atomic job claiming prevents multiple workers from simultaneously owning the same processing attempt.
- Processing leases identify abandoned jobs.
- Heartbeats renew leases during execution.
- Expired-job recovery creates new outbox events for eligible jobs.

### Idempotency

Job effects and idempotency records are persisted transactionally. Unique database constraints provide protection against duplicate effects when delivery or processing is repeated.

**Delivery semantics:** At-least-once delivery with idempotent effects. This is not an exactly-once execution guarantee.

## API Endpoints

Base URL: `http://localhost:3000`

| Method | Endpoint          | Description                     |
| ------ | ----------------- | ------------------------------- |
| POST   | `/jobs`           | Submit a new job                |
| GET    | `/jobs/:id`       | Retrieve job details and status |
| POST   | `/jobs/:id/retry` | Manually retry a failed job     |
| GET    | `/health`         | Health check                    |

### Submit a Job

```http
POST /jobs
Content-Type: application/json
```

```json
{
  "type": "EMAIL_NOTIFICATION",
  "payload": {
    "recipient": "user@example.com",
    "message": "Your job has been processed."
  }
}
```

The API validates the request and creates the job and outbox event in a database transaction.

## Tech Stack

| Technology     | Usage                     |
| -------------- | ------------------------- |
| Node.js        | Runtime                   |
| TypeScript     | Application language      |
| Express 5      | HTTP API                  |
| PostgreSQL     | Persistent database       |
| Prisma 7       | ORM and database access   |
| Redis          | Queue infrastructure      |
| BullMQ         | Background job processing |
| Vitest         | Testing                   |
| Supertest      | HTTP integration testing  |
| Docker Compose | Local infrastructure      |

## Project Structure

```text
distributed_job_processor/
├── docs/
│   └── 001-stack-selection.md
├── prisma/
│   ├── migrations/
│   └── schema.prisma
├── src/
│   ├── api/
│   │   ├── routes/
│   │   │   ├── health-check.ts
│   │   │   ├── health.ts
│   │   │   └── job.ts
│   │   ├── app.ts
│   │   └── server.ts
│   ├── db/
│   │   ├── check-connection.ts
│   │   ├── diagnose-connection.ts
│   │   └── prisma.ts
│   ├── outbox/
│   │   ├── claim-events.ts
│   │   ├── publisher.ts
│   │   └── run-publisher.ts
│   ├── queue/
│   │   └── job-queue.ts
│   └── worker/
│       ├── graceful-shutdown.ts
│       ├── handle-job-failure.ts
│       ├── handle-job.ts
│       ├── index.ts
│       ├── process-job.ts
│       ├── recover-expired-jobs.ts
│       ├── renew-processing-lease.ts
│       ├── run-recovery.ts
│       └── start-job-attempt.ts
├── tests/
├── docker-compose.yml
├── prisma.config.ts
├── package.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js
- npm
- Docker Desktop with Docker Compose

### 1. Clone the Repository

```bash
git clone https://github.com/Abhi9shinde/distributed_job_processor.git
cd distributed_job_processor
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Infrastructure

```bash
docker compose up -d
```

This starts the local PostgreSQL and Redis services.

### 4. Configure Environment Variables

Create your local environment file:

```powershell
Copy-Item .env.example .env
```

Configure the values:

```env
DATABASE_URL="postgresql://postgres:local_dev_password@localhost:5432/job_processor?schema=public"
TEST_DATABASE_URL=""
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
PORT=3000
```

Use a separate test database URL if required by your test configuration.

### 5. Generate Prisma Client and Apply Migrations

```bash
npx prisma generate
npx prisma migrate deploy
```

### 6. Start the Application Processes

Run each process in a separate terminal.

**API**

```bash
npm run dev
```

**Worker**

```bash
npm run worker
```

**Outbox Publisher**

```bash
npm run outbox:publish
```

**Expired Job Recovery**

```bash
npm run recovery
```

The API and background processing components run independently.

## Testing

Run the complete test suite:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Build the TypeScript application:

```bash
npm run build
```

Run ESLint:

```bash
npm run lint
```

Run both build and lint:

```bash
npm run check
```

## Available Scripts

| Command                  | Description                        |
| ------------------------ | ---------------------------------- |
| `npm run dev`            | Start API in development mode      |
| `npm run build`          | Compile TypeScript                 |
| `npm start`              | Start compiled API                 |
| `npm run worker`         | Start worker process               |
| `npm run outbox:publish` | Start continuous outbox publisher  |
| `npm run recovery`       | Start expired-job recovery process |
| `npm test`               | Run test suite                     |
| `npm run test:watch`     | Run tests in watch mode            |
| `npm run lint`           | Run ESLint                         |
| `npm run check`          | Build and lint                     |
| `npm run test:db`        | Check database connection          |

## Design Decisions

Some of the key engineering decisions in this project:

- PostgreSQL is the source of truth for job state.
- The Transactional Outbox Pattern avoids losing events between database commits and queue publication.
- BullMQ provides queue delivery and retry scheduling.
- Database-level conditional updates and unique constraints enforce ownership and idempotency.
- Leases allow recovery from crashed publishers and workers.
- API, publisher, recovery, and worker processes can run independently.

## Limitations and Future Improvements

Potential future improvements include:

- Structured logging and centralized observability.
- Metrics for queue depth, processing throughput, and retry rates.
- Distributed rate limiting.
- Configurable worker scaling and deployment orchestration.
- More extensive load and fault-injection testing.

---

## License

This project is currently distributed under the license specified in `package.json`.

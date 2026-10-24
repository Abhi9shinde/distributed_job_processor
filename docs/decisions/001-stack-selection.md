# ADR 001: Initial Technology Stack

## Status

Accepted

## Context

We are building a distributed job processing platform.
It needs to accept jobs through an HTTP API, process them
asynchronously, retry failures, and support horizontal scaling.

## Decision

- TypeScript and Node.js for API and worker processes.
- Express for HTTP routing.
- PostgreSQL for durable application data.
- Redis and BullMQ for asynchronous job processing.
- Docker Compose for local infrastructure.
- Vitest and Supertest for automated testing.

## Alternatives Considered

- Native Node.js HTTP instead of Express.
- A custom Redis-based queue instead of BullMQ.
- An in-memory queue instead of durable infrastructure.

## Consequences

- TypeScript provides compile-time checks but requires a build step.
- BullMQ reduces the need to implement queue mechanics ourselves.
- PostgreSQL provides durable storage and transactional guarantees.
- Redis introduces another service that must be monitored and operated.
- Docker Compose makes local development more reproducible.

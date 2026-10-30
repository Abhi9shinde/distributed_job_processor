import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma.js";
import { claimPendingEvents } from "../../src/outbox/claim-events.js";
import { jobQueue } from "../../src/queue/job-queue.js";
import { publishPendingOutboxEvents } from "../../src/outbox/publisher.js";

describe("Outbox lease reclaim", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("prevents a stale publisher from overwriting a new lease", async () => {
    const job = await prisma.job.create({
      data: {
        type: "LEASE_RECLAIM_TEST",
        payload: { test: true },
        status: "QUEUED",
      },
    });

    const event = await prisma.outBoxEvent.create({
      data: {
        jobId: job.id,
        eventType: "JOB_CREATED",
        payload: { jobId: job.id },
        status: "PENDING",
      },
    });

    try {
      // Publisher A claims the event.
      const claimA = await claimPendingEvents();

      expect(claimA.events.some((item) => item.id === event.id)).toBe(true);

      const tokenA = claimA.claimToken;

      // Simulate A crashing and its lease expiring.
      await prisma.outBoxEvent.update({
        where: { id: event.id },
        data: {
          claimedUntil: new Date(Date.now() - 1_000),
        },
      });

      // Publisher B reclaims the expired event.
      const claimB = await claimPendingEvents();

      expect(claimB.events.some((item) => item.id === event.id)).toBe(true);
      expect(claimB.claimToken).not.toBe(tokenA);

      const tokenB = claimB.claimToken;

      // A resumes and tries to mark the event as published.
      const staleUpdate = await prisma.outBoxEvent.updateMany({
        where: {
          id: event.id,
          status: "PENDING",
          claimToken: tokenA,
        },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          claimToken: null,
          claimedUntil: null,
        },
      });

      // A no longer owns the lease, so its update must fail.
      expect(staleUpdate.count).toBe(0);

      const persistedEvent = await prisma.outBoxEvent.findUniqueOrThrow({
        where: { id: event.id },
      });

      expect(persistedEvent.status).toBe("PENDING");
      expect(persistedEvent.claimToken).toBe(tokenB);
      expect(persistedEvent.claimedUntil!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await prisma.outBoxEvent.deleteMany({
        where: { id: event.id },
      });

      await prisma.job.deleteMany({
        where: { id: job.id },
      });
    }
  }, 15000);

  it("does not create a duplicate BullMQ job after a publisher crash", async () => {
    const job = await prisma.job.create({
      data: {
        type: "OUTBOX_CRASH_WINDOW_TEST",
        payload: { test: true },
        status: "QUEUED",
      },
    });

    const event = await prisma.outBoxEvent.create({
      data: {
        jobId: job.id,
        eventType: "JOB_CREATED",
        payload: {
          jobId: job.id,
          type: job.type,
          payload: job.payload,
        },
        status: "PENDING",
      },
    });

    const queueJobId = `outbox-${event.id}`;

    try {
      // Publisher A claims the event.
      const claimA = await claimPendingEvents();

      expect(claimA.events.some((item) => item.id === event.id)).toBe(true);

      // Publisher A successfully adds the job to BullMQ.
      await jobQueue.add(event.eventType, event.payload, {
        jobId: queueJobId,
        attempts: job.maxAttempts,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      });

      // Simulate a crash: A never marks the outbox event as PUBLISHED.
      // Expire its lease so another publisher can reclaim it.
      await prisma.outBoxEvent.update({
        where: { id: event.id },
        data: {
          claimedUntil: new Date(Date.now() - 1_000),
        },
      });

      // Publisher B reclaims the event and runs the actual publisher logic.
      await publishPendingOutboxEvents();

      // The event should eventually be marked as PUBLISHED.
      const updatedEvent = await prisma.outBoxEvent.findUniqueOrThrow({
        where: { id: event.id },
      });

      expect(updatedEvent.status).toBe("PUBLISHED");

      // The original BullMQ job should still exist under the same stable ID.
      const queueJob = await jobQueue.getJob(queueJobId);

      expect(queueJob).toBeDefined();
      expect(queueJob?.id).toBe(queueJobId);
      expect(queueJob?.data).toEqual(event.payload);
    } finally {
      const queueJob = await jobQueue.getJob(queueJobId);
      if (queueJob) await queueJob.remove();

      await prisma.outBoxEvent.deleteMany({
        where: { id: event.id },
      });

      await prisma.job.deleteMany({
        where: { id: job.id },
      });
    }
  }, 15_000);
});

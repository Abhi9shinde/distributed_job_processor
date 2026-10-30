import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { handleJob } from "../../src/worker/handle-job.js";
import { startJobAttempt } from "../../src/worker/start-job-attempt.js";

describe("Worker handler retry recovery", () => {
  let jobId: string | undefined;

  afterAll(async () => {
    if (jobId) {
      await prisma.idempotencyRecord.deleteMany({ where: { jobId } });
      await prisma.jobEffect.deleteMany({ where: { jobId } });
      await prisma.job.deleteMany({ where: { id: jobId } });
    }
  });

  it("recovers after completion update failure without duplicating the effect", async () => {
    const job = await prisma.job.create({
      data: {
        type: `worker-retry-${randomUUID()}`,
        payload: { test: true },
      },
    });
    jobId = job.id;

    // First attempt: the real handler runs, but we simulate a failure
    // immediately after the business effect succeeds.
    const firstResult = await handleJob({
      jobId,
      type: job.type,
      payload: job.payload,
    });

    expect(firstResult.processed).toBe(true);

    // Simulate the completion update not being persisted.
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "PROCESSING" },
    });

    // Retry: idempotency should prevent another business effect.
    const retryResult = await handleJob({
      jobId,
      type: job.type,
      payload: job.payload,
    });

    expect(retryResult.processed).toBe(false);
    expect(retryResult.reason).toBe("already_processed");

    expect(await prisma.jobEffect.count({ where: { jobId } })).toBe(1);

    expect(await prisma.idempotencyRecord.count({ where: { jobId } })).toBe(1);

    const finalJob = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
    });

    expect(finalJob.status).toBe("COMPLETED");
  }, 30_000);

  it("allows only one worker to claim the same job", async () => {
    const job = await prisma.job.create({
      data: {
        type: `concurrent-claim-${randomUUID()}`,
        payload: { test: true },
        status: "QUEUED",
      },
    });

    try {
      const results = await Promise.all([startJobAttempt(job.id), startJobAttempt(job.id)]);

      const successfulClaims = results.filter((attemptId) => attemptId !== null);

      const rejectedClaims = results.filter((attemptId) => attemptId === null);

      expect(successfulClaims).toHaveLength(1);
      expect(rejectedClaims).toHaveLength(1);

      const updatedJob = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });

      expect(updatedJob.status).toBe("PROCESSING");
      expect(updatedJob.currentAttemptId).toBe(successfulClaims[0]);
      expect(updatedJob.attempts).toBe(1);
    } finally {
      await prisma.job.deleteMany({
        where: { id: job.id },
      });
    }
  }, 15_000);

  it("clears lastError when a retried job completes successfully", async () => {
    const attemptId = crypto.randomUUID();

    const job = await prisma.job.create({
      data: {
        type: "RETRY_SUCCESS_TEST",
        payload: {},
        status: "PROCESSING",
        attempts: 2,
        currentAttemptId: attemptId,
        processingLeaseExpiresAt: new Date(Date.now() + 60_000),
        lastError: "Previous attempt failed",
      },
    });

    try {
      await handleJob({
        jobId: job.id,
        type: job.type,
        payload: job.payload,
        attemptId,
        attemptsMade: 1,
        maxAttempts: 3,
      });

      const updatedJob = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });

      expect(updatedJob.status).toBe("COMPLETED");
      expect(updatedJob.lastError).toBeNull();
      expect(updatedJob.currentAttemptId).toBeNull();
      expect(updatedJob.processingLeaseExpiresAt).toBeNull();
    } finally {
      await prisma.jobEffect.deleteMany({ where: { jobId: job.id } });
      await prisma.idempotencyRecord.deleteMany({ where: { jobId: job.id } });
      await prisma.job.deleteMany({ where: { id: job.id } });
    }
  }, 15_000);
});

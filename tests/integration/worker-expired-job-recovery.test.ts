import { describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma.js";
import { recoverExpiredProcessingJobs } from "../../src/worker/recover-expired-jobs.js";
import { Worker } from "bullmq";
import { jobQueue } from "../../src/queue/job-queue.js";
import { publishPendingOutboxEvents } from "../../src/outbox/publisher.js";
import { startJobAttempt } from "../../src/worker/start-job-attempt.js";
import { handleJob } from "../../src/worker/handle-job.js";

describe("Expired processing job recovery", () => {
  it("recovers expired jobs without touching active leases", async () => {
    const expiredAttemptId = crypto.randomUUID();
    const activeAttemptId = crypto.randomUUID();
    const now = new Date();

    const expiredJob = await prisma.job.create({
      data: {
        type: "EXPIRED_RECOVERY_TEST",
        payload: {},
        status: "PROCESSING",
        currentAttemptId: expiredAttemptId,
        processingLeaseExpiresAt: new Date(now.getTime() - 10_000),
      },
    });

    const activeJob = await prisma.job.create({
      data: {
        type: "ACTIVE_RECOVERY_TEST",
        payload: {},
        status: "PROCESSING",
        currentAttemptId: activeAttemptId,
        processingLeaseExpiresAt: new Date(now.getTime() + 60_000),
      },
    });

    try {
      const recoveredCount = await recoverExpiredProcessingJobs(now);

      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      const recovered = await prisma.job.findUniqueOrThrow({
        where: { id: expiredJob.id },
      });

      expect(recovered.status).toBe("RETRYING");
      expect(recovered.currentAttemptId).toBeNull();
      expect(recovered.processingLeaseExpiresAt).toBeNull();

      const stillActive = await prisma.job.findUniqueOrThrow({
        where: { id: activeJob.id },
      });

      expect(stillActive.status).toBe("PROCESSING");
      expect(stillActive.currentAttemptId).toBe(activeAttemptId);
      expect(stillActive.processingLeaseExpiresAt?.getTime()).toBe(
        new Date(now.getTime() + 60_000).getTime(),
      );
    } finally {
      await prisma.job.deleteMany({
        where: { id: { in: [expiredJob.id, activeJob.id] } },
      });
    }
  }, 15_000);

  it("recovers an expired job and processes it through BullMQ", async () => {
    const now = new Date();
    const attemptId = crypto.randomUUID();

    const job = await prisma.job.create({
      data: {
        type: "CRASH_RECOVERY_TEST",
        payload: {},
        status: "PROCESSING",
        currentAttemptId: attemptId,
        processingLeaseExpiresAt: new Date(now.getTime() - 10_000),
      },
    });

    const worker = new Worker(
      "jobs",
      async (queueJob) => {
        const { jobId, type, payload } = queueJob.data as {
          jobId: string;
          type: string;
          payload: unknown;
        };

        const newAttemptId = await startJobAttempt(jobId);
        if (!newAttemptId) {
          return { skipped: true };
        }

        return handleJob({
          jobId,
          type,
          payload,
          attemptId: newAttemptId,
          attemptsMade: queueJob.attemptsMade,
          maxAttempts: queueJob.opts.attempts ?? 1,
        });
      },
      {
        connection: {
          host: process.env.REDIS_HOST ?? "127.0.0.1",
          port: Number(process.env.REDIS_PORT ?? 6379),
        },
      },
    );

    try {
      const recoveredCount = await recoverExpiredProcessingJobs(now);
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      const recoveryEvent = await prisma.outBoxEvent.findFirstOrThrow({
        where: { jobId: job.id, status: "PENDING" },
      });

      await publishPendingOutboxEvents();

      await expect
        .poll(
          async () => {
            const updatedJob = await prisma.job.findUniqueOrThrow({
              where: { id: job.id },
            });
            return updatedJob.status;
          },
          { timeout: 15_000, interval: 250 },
        )
        .toBe("COMPLETED");

      const effectCount = await prisma.jobEffect.count({
        where: { jobId: job.id },
      });

      expect(effectCount).toBe(1);

      const publishedEvent = await prisma.outBoxEvent.findUniqueOrThrow({
        where: { id: recoveryEvent.id },
      });

      expect(publishedEvent.status).toBe("PUBLISHED");
    } finally {
      await worker.close();

      const queueJob = await jobQueue.getJob(`outbox-${job.id}`);
      if (queueJob) await queueJob.remove();

      await prisma.outBoxEvent.deleteMany({
        where: { jobId: job.id },
      });
      await prisma.jobEffect.deleteMany({
        where: { jobId: job.id },
      });
      await prisma.idempotencyRecord.deleteMany({
        where: { jobId: job.id },
      });
      await prisma.job.deleteMany({
        where: { id: job.id },
      });
    }
  }, 30_000);
});

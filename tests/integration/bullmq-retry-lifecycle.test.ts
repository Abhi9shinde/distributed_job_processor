import { afterAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { startJobAttempt } from "../../src/worker/start-job-attempt.js";
import { handleJob } from "../../src/worker/handle-job.js";
import { handleJobFailure } from "../../src/worker/handle-job-failure.js";

describe("BullMQ retry lifecycle", () => {
  const queueName = `retry-test-${randomUUID()}`;
  const connection = {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
  };

  const queue = new Queue(queueName, { connection });
  let worker: Worker | undefined;
  let jobId: string | undefined;

  afterAll(async () => {
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();

    if (jobId) {
      await prisma.idempotencyRecord.deleteMany({ where: { jobId } });
      await prisma.jobEffect.deleteMany({ where: { jobId } });
      await prisma.outBoxEvent.deleteMany({ where: { jobId } });
      await prisma.job.deleteMany({ where: { id: jobId } });
    }
  });

  it("retries a failed attempt and eventually completes the job", async () => {
    const job = await prisma.job.create({
      data: {
        type: `retry-lifecycle-${randomUUID()}`,
        payload: { test: true },
      },
    });
    jobId = job.id;

    let processorAttempts = 0;

    worker = new Worker(
      queueName,
      async (queueJob) => {
        const {
          jobId: id,
          type,
          payload,
        } = queueJob.data as {
          jobId: string;
          type: string;
          payload: unknown;
        };

        const attemptId = await startJobAttempt(id);
        processorAttempts++;

        try {
          if (processorAttempts === 1) {
            throw new Error("Simulated first-attempt failure");
          }

          return await handleJob({
            jobId: id,
            type,
            payload,
            attemptId,
            attemptsMade: queueJob.attemptsMade,
            maxAttempts: queueJob.opts.attempts ?? 1,
          });
        } catch (error) {
          await handleJobFailure(
            {
              id: queueJob.id,
              data: { jobId: id },
              attemptsMade: queueJob.attemptsMade + 1,
              opts: { attempts: queueJob.opts.attempts },
            },
            error instanceof Error ? error : new Error(String(error)),
            attemptId,
          );

          throw error;
        }
      },
      { connection },
    );

    await worker.waitUntilReady();

    const completed = new Promise<void>((resolve, reject) => {
      worker!.on("completed", (completedJob) => {
        if (completedJob.id === queueJobId) resolve();
      });
      worker!.on("error", reject);
    });

    const queuedJob = await queue.add(
      "retry-lifecycle",
      { jobId: job.id, type: job.type, payload: job.payload },
      {
        attempts: 2,
        backoff: { type: "fixed", delay: 100 },
        removeOnComplete: true,
      },
    );

    const queueJobId = queuedJob.id;
    await completed;

    const finalJob = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(processorAttempts).toBe(2);
    expect(finalJob.status).toBe("COMPLETED");
    expect(finalJob.currentAttemptId).toBeNull();
    expect(await prisma.jobEffect.count({ where: { jobId: job.id } })).toBe(1);
    expect(await prisma.idempotencyRecord.count({ where: { jobId: job.id } })).toBe(1);
  }, 30_000);
});

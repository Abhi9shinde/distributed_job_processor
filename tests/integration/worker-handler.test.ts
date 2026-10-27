import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { handleJob } from "../../src/worker/handle-job.js";

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
});

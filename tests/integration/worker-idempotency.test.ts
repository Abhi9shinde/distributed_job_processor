import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { processJobIdempotently } from "../../src/worker/process-job.js";

describe("Worker idempotency during retry", () => {
  const createdJobIds: string[] = [];

  afterAll(async () => {
    if (createdJobIds.length > 0) {
      await prisma.idempotencyRecord.deleteMany({
        where: { jobId: { in: createdJobIds } },
      });

      await prisma.jobEffect.deleteMany({
        where: { jobId: { in: createdJobIds } },
      });

      await prisma.job.deleteMany({
        where: { id: { in: createdJobIds } },
      });
    }
  });

  it("does not duplicate the effect when processing is retried", async () => {
    const job = await prisma.job.create({
      data: {
        type: `retry-test-${randomUUID()}`,
        payload: { test: "status-update-failure" },
      },
    });

    createdJobIds.push(job.id);

    // First attempt: the business effect succeeds.
    const firstAttempt = await processJobIdempotently(job.id);

    expect(firstAttempt.processed).toBe(true);

    // Simulate a failure after the effect succeeded but before
    // the worker could mark the job COMPLETED.
    const secondAttempt = await processJobIdempotently(job.id);

    expect(secondAttempt.processed).toBe(false);
    expect(secondAttempt.reason).toBe("already_processed");

    // The business effect must still exist only once.
    expect(
      await prisma.jobEffect.count({
        where: { jobId: job.id },
      }),
    ).toBe(1);

    expect(
      await prisma.idempotencyRecord.count({
        where: { jobId: job.id },
      }),
    ).toBe(1);
  }, 30_000);
});

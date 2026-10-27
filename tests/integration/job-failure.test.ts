import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { handleJobFailure } from "../../src/worker/handle-job-failure.js";

describe("Job failure handling", () => {
  const createdJobIds: string[] = [];

  afterAll(async () => {
    if (createdJobIds.length > 0) {
      await prisma.idempotencyRecord.deleteMany({
        where: { jobId: { in: createdJobIds } },
      });
      await prisma.jobEffect.deleteMany({
        where: { jobId: { in: createdJobIds } },
      });
      await prisma.outBoxEvent.deleteMany({
        where: { jobId: { in: createdJobIds } },
      });
      await prisma.job.deleteMany({
        where: { id: { in: createdJobIds } },
      });
    }
  });

  async function createTestJob() {
    const job = await prisma.job.create({
      data: {
        type: `failure-test-${randomUUID()}`,
        payload: { test: true },
      },
    });

    createdJobIds.push(job.id);
    return job;
  }

  it("does not mark a job FAILED while retries remain", async () => {
    const job = await createTestJob();

    await handleJobFailure(
      {
        id: "queue-job-retry",
        data: { jobId: job.id },
        attemptsMade: 1,
        opts: { attempts: 3 },
      },
      new Error("Temporary failure"),
    );

    const updated = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(updated.status).not.toBe("FAILED");
  }, 30_000);

  it("marks a job FAILED after attempts are exhausted", async () => {
    const job = await createTestJob();

    await handleJobFailure(
      {
        id: "queue-job-terminal",
        data: { jobId: job.id },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error("Permanent failure"),
    );

    const updated = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(updated.status).toBe("FAILED");
  }, 30_000);
});

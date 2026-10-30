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

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        currentAttemptId: "attempt-1",
      },
    });

    await handleJobFailure(
      {
        id: "queue-job-retry",
        data: { jobId: job.id },
        attemptsMade: 1,
        opts: { attempts: 3 },
      },
      new Error("Temporary failure"),
      "attempt-1",
    );

    const updated = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(updated.status).toBe("RETRYING");
  }, 30_000);

  it("marks a job RETRYING while retries remain", async () => {
    const job = await createTestJob();

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        currentAttemptId: "attempt-1",
      },
    });

    await handleJobFailure(
      {
        id: "queue-job-retrying",
        data: { jobId: job.id },
        attemptsMade: 1,
        opts: { attempts: 3 },
      },
      new Error("Temporary failure"),
      "attempt-1",
    );

    const updated = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(updated.status).toBe("RETRYING");
    expect(updated.currentAttemptId).toBeNull();
  }, 30_000);

  it("marks a job FAILED after attempts are exhausted", async () => {
    const job = await createTestJob();

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: 3,
        currentAttemptId: "attempt-3",
      },
    });

    await handleJobFailure(
      {
        id: "queue-job-terminal",
        data: { jobId: job.id },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error("Permanent failure"),
      "attempt-3",
    );

    const updated = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(updated.status).toBe("FAILED");
    expect(updated.lastError).toBe("Permanent failure");
    expect(updated.currentAttemptId).toBeNull();
  }, 30_000);

  it("does not let a stale failure overwrite a newer attempt", async () => {
    const job = await createTestJob();

    // Simulate attempt 2 currently owning the job.
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: 2,
        currentAttemptId: "attempt-2",
      },
    });

    // Attempt 1 fails late. Its ID must not match the current owner.
    await handleJobFailure(
      {
        id: "queue-job-stale",
        data: { jobId: job.id },
        attemptsMade: 1,
        opts: { attempts: 3 },
      },
      new Error("Late failure from attempt 1"),
      "attempt-1",
    );

    const updated = await prisma.job.findUniqueOrThrow({
      where: { id: job.id },
    });

    expect(updated.status).toBe("PROCESSING");
    expect(updated.currentAttemptId).toBe("attempt-2");
  }, 30_000);
});

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { processJobIdempotently } from "../../src/worker/process-job.js";

describe("Job idempotency", () => {
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

  async function createTestJob() {
    const job = await prisma.job.create({
      data: {
        type: `idempotency-test-${randomUUID()}`,
        payload: { test: true },
      },
    });

    createdJobIds.push(job.id);
    return job;
  }

  it("creates one effect when processing the same job twice", async () => {
    const job = await createTestJob();

    const first = await processJobIdempotently(job.id);
    const second = await processJobIdempotently(job.id);

    expect(first.processed).toBe(true);
    expect(second.processed).toBe(false);
    expect(second.reason).toBe("already_processed");

    expect(await prisma.jobEffect.count({ where: { jobId: job.id } })).toBe(1);

    expect(await prisma.idempotencyRecord.count({ where: { jobId: job.id } })).toBe(1);
  }, 30_000);

  it("creates one effect under concurrent processing", async () => {
    const job = await createTestJob();

    const results = await Promise.all([
      processJobIdempotently(job.id),
      processJobIdempotently(job.id),
    ]);

    expect(results.filter((result) => result.processed)).toHaveLength(1);
    expect(results.filter((result) => !result.processed)).toHaveLength(1);

    expect(await prisma.jobEffect.count({ where: { jobId: job.id } })).toBe(1);

    expect(await prisma.idempotencyRecord.count({ where: { jobId: job.id } })).toBe(1);
  }, 30_000);

  it("rolls back the effect if the idempotency record cannot be created", async () => {
    const job = await createTestJob();
    const idempotencyKey = `job:${job.id}`;

    // Seed a conflicting idempotency record.
    await prisma.idempotencyRecord.create({
      data: {
        idempotencyKey,
        jobId: job.id,
        result: { seeded: true },
      },
    });

    // The effect insert succeeds inside the transaction, but the
    // idempotency insert conflicts with the unique key and rolls it back.
    await expect(processJobIdempotently(job.id)).rejects.toMatchObject({
      code: "P2002",
    });

    expect(await prisma.jobEffect.count({ where: { jobId: job.id } })).toBe(0);
  }, 30_000);
});

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma.js";
import { claimPendingEvents } from "../../src/outbox/claim-events.js";

describe("Outbox concurrent claiming (Neon integration)", () => {
  const testRunId = randomUUID();
  const createdJobIds: string[] = [];

  afterAll(async () => {
    if (createdJobIds.length > 0) {
      await prisma.outBoxEvent.deleteMany({
        where: { jobId: { in: createdJobIds } },
      });

      await prisma.job.deleteMany({
        where: { id: { in: createdJobIds } },
      });
    }
  });

  it("does not claim the same event in two concurrent calls", async () => {
    // Create 12 uniquely tagged jobs and outbox events.
    for (let i = 0; i < 12; i++) {
      const job = await prisma.job.create({
        data: {
          type: `concurrency-test-${testRunId}`,
          payload: { testRunId, index: i },
        },
      });

      createdJobIds.push(job.id);

      await prisma.outBoxEvent.create({
        data: {
          jobId: job.id,
          eventType: "JOB_CREATED",
          payload: {
            jobId: job.id,
            type: job.type,
            payload: job.payload,
            testRunId,
          },
        },
      });
    }

    const [first, second] = await Promise.all([claimPendingEvents(), claimPendingEvents()]);

    const firstIds = first.events.map((event) => event.id);
    const secondIds = second.events.map((event) => event.id);

    const overlap = firstIds.filter((id) => secondIds.includes(id));

    expect(overlap).toEqual([]);
    expect(firstIds.length + secondIds.length).toBe(12);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(12);
  }, 30_000);
});

import { describe, expect, it } from "vitest";
import { prisma } from "../../src/db/prisma.js";
import { renewProcessingLease } from "../../src/worker/renew-processing-lease.js";

describe("Worker processing lease renewal", () => {
  it("renews the lease for the current attempt", async () => {
    const attemptId = crypto.randomUUID();

    const job = await prisma.job.create({
      data: {
        type: "LEASE_RENEWAL_TEST",
        payload: { test: true },
        status: "PROCESSING",
        currentAttemptId: attemptId,
        processingLeaseExpiresAt: new Date(Date.now() - 10_000),
      },
    });

    try {
      const renewed = await renewProcessingLease(job.id, attemptId);

      expect(renewed).toBe(true);

      const updatedJob = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });

      expect(updatedJob.processingLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    } finally {
      await prisma.job.deleteMany({ where: { id: job.id } });
    }
  }, 15_000);

  it("does not renew a lease for a stale attempt", async () => {
    const currentAttemptId = crypto.randomUUID();
    const staleAttemptId = crypto.randomUUID();
    const originalExpiry = new Date(Date.now() + 45_000);

    const job = await prisma.job.create({
      data: {
        type: "STALE_LEASE_TEST",
        payload: { test: true },
        status: "PROCESSING",
        currentAttemptId,
        processingLeaseExpiresAt: originalExpiry,
      },
    });

    try {
      const renewed = await renewProcessingLease(job.id, staleAttemptId);

      expect(renewed).toBe(false);

      const updatedJob = await prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });

      expect(updatedJob.currentAttemptId).toBe(currentAttemptId);
      expect(updatedJob.processingLeaseExpiresAt?.getTime()).toBe(originalExpiry.getTime());
    } finally {
      await prisma.job.deleteMany({ where: { id: job.id } });
    }
  });
});

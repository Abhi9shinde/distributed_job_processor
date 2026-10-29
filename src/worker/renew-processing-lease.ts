import { prisma } from "../db/prisma.js";

const PROCESSING_LEASE_DURATION_MS = 60_000;

export async function renewProcessingLease(jobId: string, attemptId: string): Promise<boolean> {
  const result = await prisma.job.updateMany({
    where: {
      id: jobId,
      currentAttemptId: attemptId,
      status: "PROCESSING",
    },
    data: {
      processingLeaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_DURATION_MS),
    },
  });

  return result.count === 1;
}

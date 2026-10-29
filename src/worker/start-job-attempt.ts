import { prisma } from "../db/prisma.js";
import { randomUUID } from "crypto";

const PROCESSING_LEASE_DURATION_MS = 60_000;

export async function startJobAttempt(jobId: string): Promise<string> {
  const attemptId = randomUUID();

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      currentAttemptId: attemptId,
      processingLeaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_DURATION_MS),
    },
  });

  return attemptId;
}

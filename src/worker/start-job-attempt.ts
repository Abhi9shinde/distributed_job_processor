import { prisma } from "../db/prisma.js";
import { randomUUID } from "crypto";

const PROCESSING_LEASE_DURATION_MS = 60_000;

export async function startJobAttempt(jobId: string): Promise<string | null> {
  const attemptId = randomUUID();

  const result = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: { in: ["QUEUED", "RETRYING"] },
      currentAttemptId: null,
    },
    data: {
      status: "PROCESSING",
      currentAttemptId: attemptId,
      attempts: { increment: 1 },
      processingLeaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_DURATION_MS),
    },
  });

  if (result.count !== 1) {
    console.log(
      `Failed to start job attempt for jobId ${jobId}. Job may not be in a valid state to start processing.`,
    );
    return null;
  }

  return attemptId;
}

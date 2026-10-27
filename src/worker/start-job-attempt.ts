import { prisma } from "../db/prisma.js";
import { randomUUID } from "crypto";

export async function startJobAttempt(jobId: string): Promise<string> {
  const attemptId = randomUUID();

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      currentAttemptId: attemptId,
    },
  });

  return attemptId;
}

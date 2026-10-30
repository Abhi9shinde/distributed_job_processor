import { prisma } from "../db/prisma.js";

export async function handleJobFailure(
  job: {
    id?: string;
    data: { jobId: string };
    attemptsMade: number;
    opts: { attempts?: number };
  },
  error: Error,
  attemptId: string,
): Promise<void> {
  console.error(`Queue job ${job.id} failed:`, error.message);

  const maxAttempts = job.opts.attempts ?? 1;

  const nextStatus = job.attemptsMade < maxAttempts ? "RETRYING" : "FAILED";

  const result = await prisma.job.updateMany({
    where: {
      id: job.data.jobId,
      currentAttemptId: attemptId,
      status: "PROCESSING",
    },
    data: {
      status: nextStatus,
      currentAttemptId: null,
      processingLeaseExpiresAt: null,
      lastError: error.message,
    },
  });

  if (result.count === 0) {
    console.log(
      `Skipping stale failure update for job ${job.data.jobId}, attempt ${job.attemptsMade}.`,
    );
    return;
  }

  if (nextStatus === "RETRYING") {
    console.log(`Job ${job.id} will be retried (${job.attemptsMade}/${maxAttempts}).`);
  } else {
    console.log(`Job ${job.data.jobId} exhausted retries and is marked FAILED.`);
  }
}

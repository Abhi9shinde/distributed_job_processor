import { prisma } from "../db/prisma.js";

export async function handleJobFailure(
  job: {
    id?: string;
    data: { jobId: string };
    attemptsMade: number;
    opts: { attempts?: number };
  },
  error: Error,
): Promise<void> {
  console.error(`Queue job ${job.id} failed:`, error.message);

  const maxAttempts = job.opts.attempts ?? 1;

  if (job.attemptsMade < maxAttempts) {
    console.log(`Job ${job.id} will be retried (${job.attemptsMade}/${maxAttempts}).`);
    return;
  }

  await prisma.job.update({
    where: { id: job.data.jobId },
    data: { status: "FAILED" },
  });

  console.log(`Job ${job.data.jobId} exhausted retries and is marked FAILED.`);
}

//processing logic from src/worker/index.ts so we can test failures without starting a real Redis worker.

import { prisma } from "../db/prisma.js";
import { processJobIdempotently } from "./process-job.js";

export async function handleJob(data: { jobId: string; type: string; payload: unknown }) {
  const { jobId, type, payload } = data;

  //updating jobStatus to processing
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "PROCESSING" },
  });
  console.log(`Processing job ${jobId} of type ${type} with payload:`, payload);

  // Apply the business effect idempotently.
  const result = await processJobIdempotently(jobId);

  //updating jobStatus to completed
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "COMPLETED" },
  });
  if (result.processed) {
    console.log(`Completed job ${jobId}`);
  } else {
    console.log(`Job ${jobId} was already processed; skipping duplicate effect.`);
  }
  return result;
}

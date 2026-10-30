//processing logic from src/worker/index.ts so we can test failures without starting a real Redis worker.

import { prisma } from "../db/prisma.js";
import { processJobIdempotently } from "./process-job.js";
import { handleJobFailure } from "./handle-job-failure.js";
import { renewProcessingLease } from "./renew-processing-lease.js";

const HEARTBEAT_INTERVAL_MS = 20_000; // 20 seconds

export async function handleJob(data: {
  jobId: string;
  type: string;
  payload: unknown;
  attemptId: string;
  attemptsMade: number;
  maxAttempts: number;
}) {
  const { jobId, type, payload, attemptId, attemptsMade, maxAttempts } = data;

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  console.log(`Processing job ${jobId} of type ${type} with payload:`, payload);
  try {
    heartbeatTimer = setInterval(() => {
      void renewProcessingLease(jobId, attemptId)
        .then((success) => {
          if (!success) {
            console.error(`Attempt ${attemptId} lost lease for job ${jobId}.`);
            leaseLost = true;
            stopHeartbeat();
          }
        })
        .catch((err) => {
          leaseLost = true;
          stopHeartbeat();
          console.error(`Could not renew lease for job ${jobId}:`, err);
        });
    }, HEARTBEAT_INTERVAL_MS);
    // Apply the business effect idempotently.
    const result = await processJobIdempotently(jobId);

    if (leaseLost) {
      throw new Error(`Processing lease lost for job ${jobId}.`);
    }

    //updating jobStatus to completed
    const completion = await prisma.job.updateMany({
      where: {
        id: jobId,
        currentAttemptId: attemptId,
        status: "PROCESSING",
      },
      data: {
        status: "COMPLETED",
        currentAttemptId: null,
        processingLeaseExpiresAt: null,
        lastError: null,
      },
    });
    if (completion.count === 0) {
      console.log(`Attempt ${attemptId} no longer owns job ${jobId}.`);
    } else if (result.processed) {
      console.log(`Completed job ${jobId}`);
    } else {
      console.log(`Job ${jobId} was already processed; skipping duplicate effect.`);
    }
    return result;
  } catch (error) {
    await handleJobFailure(
      { data: { jobId }, attemptsMade: attemptsMade + 1, opts: { attempts: maxAttempts } },
      error instanceof Error ? error : new Error(String(error)),
      attemptId,
    );
    throw error; // rethrow to let the worker know the job failed
  } finally {
    stopHeartbeat();
  }
}

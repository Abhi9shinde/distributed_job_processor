import { Worker } from "bullmq";
import { prisma } from "../db/prisma.js";
// import { processJobIdempotently } from "./process-job.js";
import { handleJob } from "./handle-job.js";
// import { handleJobFailure } from "./handle-job-failure.js";
import { startJobAttempt } from "./start-job-attempt.js";
import { createGracefulShutdown } from "./graceful-shutdown.js";

const redisHost = process.env.REDIS_HOST ?? "127.0.0.1";
const redisPort = Number(process.env.REDIS_PORT ?? 6379);

const worker = new Worker(
  "jobs",
  async (queueJob) => {
    const { jobId, type, payload } = queueJob.data as {
      jobId: string;
      type: string;
      payload: unknown;
    };

    const attemptId = await startJobAttempt(jobId);
    if (!attemptId) {
      return { skipped: true, reason: "Job may not be in a valid state to start processing." };
    }
    return handleJob({
      jobId,
      type,
      payload,
      attemptId,
      attemptsMade: queueJob.attemptsMade,
      maxAttempts: queueJob.opts.attempts ?? 1,
    });
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
    },
  },
);

worker.on("completed", (queueJob) => {
  console.log(`Job ${queueJob.id} has been completed.`);
});

worker.on("failed", async (queueJob, err) => {
  console.error(`Job ${queueJob?.id} has failed with error:`, err);
  if (!queueJob) return;
  //this is done in handle-job
  // try {
  //   await handleJobFailure(queueJob, err);
  // } catch (err) {
  //   console.error(`Error handling job failure for job ${queueJob.id}:`, err);
  // }
});

// let isShuttingDown = false;
// async function gracefulShutdown(signal: string): Promise<void> {
//   if (isShuttingDown) {
//     console.log(`Received ${signal} signal again. Already shutting down...`);
//     return;
//   }

//   isShuttingDown = true;
//   console.log(`Received ${signal} signal. Shutting down gracefully...`);

//   try {
//     //stop accepting new jobs
//     await worker.close();
//     console.log("BullMQ worker closed");

//     //disconnect from the database
//     await prisma.$disconnect();
//     console.log("Prisma client disconnected");

//     console.log("Graceful shutdown complete. Exiting process.");
//   } catch (err) {
//     console.error("Error during graceful shutdown:", err);
//     process.exitCode = 1;
//   }
// }

const gracefulShutdown = createGracefulShutdown({
  stopProcessing: () => worker.close(),
  disconnectDatabase: () => prisma.$disconnect(),
});

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

console.log("Worker Started and listening for jobs...");

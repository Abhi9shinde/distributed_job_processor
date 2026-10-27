import { Worker } from "bullmq";
// import { prisma } from "../db/prisma.js";
// import { processJobIdempotently } from "./process-job.js";
import { handleJob } from "./handle-job.js";
import { handleJobFailure } from "./handle-job-failure.js";

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
    return handleJob({ jobId, type, payload });
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

  try {
    await handleJobFailure(queueJob, err);
  } catch (err) {
    console.error(`Error handling job failure for job ${queueJob.id}:`, err);
  }
});

console.log("Worker Started and listening for jobs...");

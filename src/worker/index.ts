import { Worker } from "bullmq";
import { prisma } from "../db/prisma.js";

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
    //updating jobStatus to processing
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "PROCESSING" },
    });
    console.log(`Processing job ${jobId} of type ${type} with payload:`, payload);

    // Temporary handler: simulate a small unit of work.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    //updating jobStatus to completed
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED" },
    });
    console.log(`Completed job ${jobId}`);
    return { success: true };
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
    },
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} has been completed.`);
});
worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} has failed with error:`, err);
});

console.log("Worker Started and listening for jobs...");

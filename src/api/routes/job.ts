import express from "express";
import { prisma } from "../../db/prisma.js";
import { z } from "zod";
// import { jobQueue } from "../../queue/job-queue.js";

const jobRouter = express.Router();

const createJobSchema = z.object({
  type: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.json()),
});

// Create a new job
jobRouter.post("/", async (req, res) => {
  const parseResult = createJobSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error });
  }
  try {
    const { type, payload } = parseResult.data;
    // const job = await prisma.job.create({
    //   data: {
    //     type,
    //     payload,
    //   },
    // });
    // // Add the job to the BullMQ queue
    // await jobQueue.add(
    //   job.type,
    //   { jobId: job.id, type: job.type, payload: job.payload },
    //   {
    //     jobId: job.id,
    //     attempts: job.attempts,
    //     backoff: { type: "exponential", delay: 1000 },
    //     removeOnComplete: 1000,
    //     removeOnFail: false,
    //   },
    // );
    //*************************************************** */
    // Use a transaction to ensure that the job is created and added to the queue atomically
    const job = await prisma.$transaction(
      async (tx) => {
        //First create the job in the database
        const createdJob = await tx.job.create({
          data: {
            type,
            payload,
          },
        });

        //add in outboxEvent
        await tx.outBoxEvent.create({
          data: {
            jobId: createdJob.id,
            eventType: "JOB_CREATED",
            payload: { jobId: createdJob.id, type: createdJob.type, payload: createdJob.payload },
          },
        });
        return createdJob;
      },
      {
        maxWait: 10000,
        timeout: 15000,
      },
    );
    res.status(201).json({ job });
  } catch (err) {
    console.error("Error creating job:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get a job by ID
jobRouter.get("/:id", async (req, res) => {
  const jobId = req.params.id as string;
  try {
    const job = await prisma.job.findUnique({
      where: {
        id: jobId,
      },
    });
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.status(200).json(job);
  } catch (err) {
    console.error("Error fetching job:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Manually retry a failed job
jobRouter.post("/:id/retry", async (req, res) => {
  const jobId = req.params.id as string;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        return { kind: "not_found" as const };
      }

      if (job.status !== "FAILED") {
        return { kind: "not_failed" as const, status: job.status };
      }

      const updated = await tx.job.updateMany({
        where: {
          id: jobId,
          status: "FAILED",
        },
        data: {
          status: "RETRYING",
          attempts: 0,
          lastError: null,
        },
      });

      if (updated.count !== 1) {
        return { kind: "not_failed" as const };
      }

      await tx.outBoxEvent.create({
        data: {
          jobId: job.id,
          eventType: "JOB_CREATED",
          payload: {
            jobId: job.id,
            type: job.type,
            payload: job.payload,
          },
        },
      });

      return { kind: "retried" as const };
    });

    if (result.kind === "not_found") {
      return res.status(404).json({ error: "Job not found" });
    }

    if (result.kind === "not_failed") {
      return res.status(409).json({
        error: "Only failed jobs can be manually retried",
        status: "status" in result ? result.status : undefined,
      });
    }

    return res.status(202).json({
      message: "Job queued for retry",
      jobId,
      status: "RETRYING",
    });
  } catch (err) {
    console.error("Error retrying job:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default jobRouter;

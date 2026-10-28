import { Router } from "express";
import { prisma } from "../../db/prisma.js";
import { jobQueue } from "../../queue/job-queue.js";
import { checkWithTimeout } from "./health-check.js";

const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Distributed Job Processor",
  });
});

healthRouter.get("/ready", async (_req, res) => {
  const [postgres, redis] = await Promise.all([
    checkWithTimeout(() => prisma.$queryRaw`SELECT 1`),
    checkWithTimeout(() => jobQueue.waitUntilReady()),
  ]);

  const ready = postgres && redis;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "not_ready",
    service: "Distributed Job Processor",
    checks: {
      postgres,
      redis,
    },
  });
});

export default healthRouter;

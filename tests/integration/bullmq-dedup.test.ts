import { afterAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";

const queueName = `dedup-test-${randomUUID()}`;

const queue = new Queue(queueName, {
  connection: {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
});

describe("BullMQ duplicate enqueue behavior", () => {
  it("does not create a second job while the same job ID exists", async () => {
    const stableJobId = "logical-job-123";

    await queue.add(
      "process-job",
      { jobId: stableJobId, type: "email", payload: { test: true } },
      { jobId: stableJobId, removeOnComplete: false },
    );

    await queue.add(
      "process-job",
      { jobId: stableJobId, type: "email", payload: { test: true } },
      { jobId: stableJobId, removeOnComplete: false },
    );

    const jobs = await queue.getJobs(["waiting", "active", "completed", "failed", "delayed"]);

    const matchingJobs = jobs.filter((job) => job.id === stableJobId);

    expect(matchingJobs).toHaveLength(1);
  }, 30_000);
});

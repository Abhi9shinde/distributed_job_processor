import { afterAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";

describe("Worker graceful shutdown", () => {
  const queueName = `shutdown-test-${Math.random().toString(36).slice(2)}`;

  const env = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;

  const connection = {
    host: env?.REDIS_HOST ?? "127.0.0.1",
    port: Number(env?.REDIS_PORT ?? 6379),
  };

  const queue = new Queue(queueName, { connection });

  let worker: Worker | undefined;
  let releaseJob: (() => void) | undefined;

  afterAll(async () => {
    // Ensure a blocked job cannot prevent test cleanup.
    releaseJob?.();

    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it("waits for an active job before closing", async () => {
    let markJobStarted!: () => void;
    let markJobCompleted!: () => void;

    const jobStarted = new Promise<void>((resolve) => {
      markJobStarted = resolve;
    });

    const jobCompleted = new Promise<void>((resolve) => {
      markJobCompleted = resolve;
    });

    let allowJobToFinish!: () => void;

    const jobGate = new Promise<void>((resolve) => {
      allowJobToFinish = resolve;
    });

    releaseJob = allowJobToFinish;

    worker = new Worker(
      queueName,
      async () => {
        markJobStarted();

        // Simulate a job that is still doing work.
        await jobGate;

        markJobCompleted();
        return { success: true };
      },
      { connection },
    );

    const activeWorker = worker;

    await activeWorker.waitUntilReady();

    const completedEvent = new Promise<void>((resolve, reject) => {
      activeWorker.on("completed", () => resolve());
      activeWorker.on("error", reject);
    });

    await queue.add("long-running-job", { test: true });
    await jobStarted;

    // Begin shutdown while the job is still active.
    let closeResolved = false;

    const closePromise = activeWorker.close().then(() => {
      closeResolved = true;
    });

    // Give the close operation a chance to resolve if it
    // incorrectly fails to wait for the active job.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(closeResolved).toBe(false);

    // Allow the active job to finish.
    allowJobToFinish();

    await jobCompleted;
    await completedEvent;
    await closePromise;

    expect(closeResolved).toBe(true);
  }, 15_000);
});

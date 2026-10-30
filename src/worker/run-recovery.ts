import { prisma } from "../db/prisma.js";
import { recoverExpiredProcessingJobs } from "./recover-expired-jobs.js";
import { createGracefulShutdown } from "./graceful-shutdown.js";

const RECOVERY_INTERVAL_MS = 10_000;

let isShuttingDown = false;
let isRunning = false;
// let recoveryTimer: NodeJS.Timeout;

async function runRecoveryCycle(): Promise<void> {
  if (isShuttingDown || isRunning) return;

  isRunning = true;

  try {
    const recoveredCount = await recoverExpiredProcessingJobs();

    if (recoveredCount > 0) {
      console.log(`Recovered ${recoveredCount} expired jobs.`);
    }
  } catch (error) {
    console.error("Expired job recovery failed:", error);
  } finally {
    isRunning = false;
  }
}

void runRecoveryCycle();

const recoveryTimer = setInterval(() => {
  void runRecoveryCycle();
}, RECOVERY_INTERVAL_MS);

const gracefulShutdown = createGracefulShutdown({
  stopProcessing: async () => {
    isShuttingDown = true;
    clearInterval(recoveryTimer);

    while (isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  disconnectDatabase: () => prisma.$disconnect(),
});

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

console.log("Expired job recovery process started.");

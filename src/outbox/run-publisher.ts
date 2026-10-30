import { prisma } from "../db/prisma.js";
import { publishPendingOutboxEvents } from "./publisher.js";
import { createGracefulShutdown } from "../worker/graceful-shutdown.js";

const PUBLISH_INTERVAL_MS = 3_000;

let isRunning = false; // prevents multiple publisher cycles from running at the same time.like a lock of some sort
let isShuttingDown = false; //prevents new cycles from starting during shutdown.

async function runPublisherCycle(): Promise<void> {
  if (isShuttingDown || isRunning) return;
  isRunning = true;

  try {
    await publishPendingOutboxEvents();
  } catch (err) {
    console.error("Outbox publisher failed:", err);
  } finally {
    isRunning = false;
  }
}

const publisherTimer = setInterval(() => {
  void runPublisherCycle();
}, PUBLISH_INTERVAL_MS);

void runPublisherCycle(); //running first cycle immediately instead of waiting for the first interval that is 3 seconds to complete.

const gracefulShutdown = createGracefulShutdown({
  stopProcessing: async () => {
    isShuttingDown = true;
    clearInterval(publisherTimer);

    while (isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  },
  disconnectDatabase: () => prisma.$disconnect(),
});

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

console.log("Continuous outbox publisher started.");

//BELOW IS EARILER APPROACH BUT THE PROBLEM IS THAT IF THE PUBLISHER FAILS, IT WILL NOT RESTART AND WILL NOT PUBLISH ANYTHING. SO I HAVE CHANGED IT TO A CONTINUOUS PUBLISHER APPROACH ABOVE LIKE RUN-RECOVERY
// import { prisma } from "../db/prisma.js";
// import { publishPendingOutboxEvents } from "./publisher.js";

// try {
//   await publishPendingOutboxEvents();
// } catch (error) {
//   console.error("Outbox publisher failed:", error);
//   process.exitCode = 1;
// } finally {
//   await prisma.$disconnect();
// }

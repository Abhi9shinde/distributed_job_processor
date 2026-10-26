import { prisma } from "../db/prisma.js";
import { publishPendingOutboxEvents } from "./publisher.js";

try {
  await publishPendingOutboxEvents();
} catch (error) {
  console.error("Outbox publisher failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

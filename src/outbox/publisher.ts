import { prisma } from "../db/prisma.js";
import { jobQueue } from "../queue/job-queue.js";
import { claimPendingEvents } from "./claim-events.js";

// const BATCH_SIZE = 10; // Number of events to process in each batch

export async function publishPendingOutboxEvents(): Promise<void> {
  const { claimToken, events } = await claimPendingEvents();

  if (events.length === 0) {
    console.log("No pending outbox events to publish.");
    return;
  }

  const claimedEvents = await prisma.outBoxEvent.findMany({
    where: {
      id: { in: events.map((event) => event.id) },
      status: "PENDING",
      claimToken: claimToken,
    },
    include: {
      job: { select: { maxAttempts: true } },
    },
  });

  const PUBLISH_CONCURRENCY = 10;

  for (let i = 0; i < claimedEvents.length; i += PUBLISH_CONCURRENCY) {
    const batch = claimedEvents.slice(i, i + PUBLISH_CONCURRENCY);

    await Promise.all(
      batch.map(async (event) => {
        try {
          //adding to the queue
          await jobQueue.add(event.eventType, event.payload, {
            jobId: `outbox-${event.id}`, //bec
            attempts: event.job.maxAttempts,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: false,
          });

          const result = await prisma.outBoxEvent.updateMany({
            where: {
              id: event.id,
              status: "PENDING",
              claimToken: claimToken,
            },
            data: {
              status: "PUBLISHED",
              publishedAt: new Date(),
              lastError: null,
              claimToken: null,
              claimedUntil: null,
            },
          });

          if (result.count !== 1) {
            console.warn(
              `Outbox event ${event.id} was enqueued, but its claim was no longer owned by this publisher.`,
            );
          } else {
            console.log(`Published outbox event ${event.id}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          console.error(`Failed to publish outbox event ${event.id}: ${message}`);

          await prisma.outBoxEvent
            .updateMany({
              where: { id: event.id, status: "PENDING", claimToken: claimToken },
              data: {
                attempts: { increment: 1 },
                lastError: message,
                claimToken: null,
                claimedUntil: null,
              },
            })
            .catch((updateError) => {
              console.error(`Failed to record outbox error for ${event.id}:`, updateError);
            });
        }
      }),
    );
  }
  //
  //
  //
  //in below for loop this was happening:
  // Event 1 → publish → update DB
  // Event 2 → publish → update DB
  // Event 3 → publish → update DB
  // ...
  // Event 10 → publish → update DB

  // for (const event of claimedEvents) {
  //   try {
  //     //adding to the queue
  //     await jobQueue.add(event.eventType, event.payload, {
  //       jobId: `outbox-${event.id}`, //bec
  //       attempts: event.job.maxAttempts,
  //       backoff: { type: "exponential", delay: 1000 },
  //       removeOnComplete: 1000,
  //       removeOnFail: false,
  //     });

  //     const result = await prisma.outBoxEvent.updateMany({
  //       where: {
  //         id: event.id,
  //         status: "PENDING",
  //         claimToken: claimToken,
  //       },
  //       data: {
  //         status: "PUBLISHED",
  //         publishedAt: new Date(),
  //         lastError: null,
  //         claimToken: null,
  //         claimedUntil: null,
  //       },
  //     });

  //     if (result.count !== 1) {
  //       console.warn(
  //         `Outbox event ${event.id} was enqueued, but its claim was no longer owned by this publisher.`,
  //       );
  //     } else {
  //       console.log(`Published outbox event ${event.id}`);
  //     }
  //   } catch (error) {
  //     const message = error instanceof Error ? error.message : String(error);

  //     console.error(`Failed to publish outbox event ${event.id}: ${message}`);

  //     await prisma.outBoxEvent
  //       .updateMany({
  //         where: { id: event.id, status: "PENDING", claimToken: claimToken },
  //         data: {
  //           attempts: { increment: 1 },
  //           lastError: message,
  //           claimToken: null,
  //           claimedUntil: null,
  //         },
  //       })
  //       .catch((updateError) => {
  //         console.error(`Failed to record outbox error for ${event.id}:`, updateError);
  //       });
  //   }
  // }
}

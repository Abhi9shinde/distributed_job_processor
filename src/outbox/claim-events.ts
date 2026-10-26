import { randomUUID } from "node:crypto";
import { prisma } from "../db/prisma.js";

const BATCH_SIZE = 10;
const LEASE_DURATION_MS = 30_000;

export async function claimPendingEvents() {
  const claimToken = randomUUID();

  const events = await prisma.$transaction(
    async (tx) => {
      return tx.$queryRaw<{ id: string; jobId: string; eventType: string; payload: unknown }[]>`
      WITH candidates AS (
        SELECT id
        FROM "OutBoxEvent"
        WHERE status = 'PENDING'::"OutBoxStatus"
          AND (
            "claimedUntil" IS NULL
            OR "claimedUntil" < NOW()
          )
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutBoxEvent" AS event
      SET
        "claimToken" = ${claimToken},
        "claimedUntil" = NOW() + (${LEASE_DURATION_MS} * INTERVAL '1 millisecond'),
        "updatedAt" = NOW()
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING
        event.id,
        event."jobId",
        event."eventType",
        event.payload
    `;
    },
    {
      maxWait: 10000,
      timeout: 15000,
    },
  );

  return { claimToken, events };
}

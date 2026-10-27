import { prisma } from "../db/prisma.js";
import { Prisma } from "../generated/prisma/client.js";

export async function processJobIdempotently(jobId: string) {
  const idempotencyKey = `job:${jobId}`;

  try {
    return prisma.$transaction(
      async (tx) => {
        // Has this business operation already been applied?
        const existing = await tx.jobEffect.findUnique({
          where: { idempotencyKey },
        });

        if (existing) {
          return {
            processed: false,
            reason: "already_processed" as const,
            effectId: existing.id,
          };
        }

        // Record the simulated business effect.
        const effect = await tx.jobEffect.create({
          data: {
            idempotencyKey,
            jobId,
            effectType: "JOB_PROCESSED",
            payload: { jobId, accepted: true },
          },
        });

        // Record idempotency in the same transaction.
        await tx.idempotencyRecord.create({
          data: {
            idempotencyKey,
            jobId,
            result: { effectId: effect.id, accepted: true },
          },
        });

        return {
          processed: true,
          reason: "processed" as const,
          effectId: effect.id,
        };
      },
      {
        maxWait: 10000,
        timeout: 15000,
      },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // A concurrent transaction may have created the effect first.
      const existing = await prisma.jobEffect.findUnique({
        where: { idempotencyKey },
      });

      if (existing) {
        return {
          processed: false,
          reason: "already_processed" as const,
          effectId: existing.id,
        };
      }
    }

    throw error;
  }
}

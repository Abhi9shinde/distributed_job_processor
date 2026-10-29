import { prisma } from "../db/prisma.js";

export async function recoverExpiredProcessingJobs(now: Date = new Date()): Promise<number> {
  // const result = await prisma.job.updateMany({
  //   where: {
  //     status: "PROCESSING",
  //     processingLeaseExpiresAt: {
  //       lte: now,
  //     },
  //   },
  //   data: {
  //     status: "RETRYING",
  //     processingLeaseExpiresAt: null,
  //     currentAttemptId: null,
  //   },
  // });
  // return result.count;

  //ABOVE CODE JUST CHANGES STATUS TO RETRYING, IT DOESNT ADD INTO THE QUEUE, SO JOBS WILL NEVER BE RETRIED. BELOW CODE ADDS THEM BACK INTO THE QUEUE
  return prisma.$transaction(async (tx) => {
    const expiredJobs = await tx.job.findMany({
      where: {
        status: "PROCESSING",
        processingLeaseExpiresAt: { lte: now },
        currentAttemptId: { not: null },
      },
      select: {
        id: true,
        type: true,
        payload: true,
        currentAttemptId: true,
        processingLeaseExpiresAt: true,
      },
      take: 10,
      orderBy: { processingLeaseExpiresAt: "asc" },
    });

    let recoveredCount = 0;

    for (const job of expiredJobs) {
      if (!job.currentAttemptId || !job.processingLeaseExpiresAt) {
        continue;
      }

      const result = await tx.job.updateMany({
        //here we use updateMany to ensure that we only update the job if it is still in the PROCESSING state and has the same currentAttemptId and processingLeaseExpiresAt. Also on thing is that if update is used it basically throws error if the job is not found, but updateMany will just return count 0 if no rows are updated
        where: {
          id: job.id,
          status: "PROCESSING",
          currentAttemptId: job.currentAttemptId,
          processingLeaseExpiresAt: { lte: now },
        },
        data: {
          status: "RETRYING",
          currentAttemptId: null,
          processingLeaseExpiresAt: null,
        },
      });

      if (result.count !== 1) {
        continue;
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

      recoveredCount++;
    }

    return recoveredCount;
  });
}

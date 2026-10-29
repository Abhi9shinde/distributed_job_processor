-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "processingLeaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Job_status_processingLeaseExpiresAt_idx" ON "Job"("status", "processingLeaseExpiresAt");

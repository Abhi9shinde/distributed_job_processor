-- CreateTable
CREATE TABLE "JobEffect" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "effectType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEffect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobEffect_idempotencyKey_key" ON "JobEffect"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JobEffect_jobId_idx" ON "JobEffect"("jobId");

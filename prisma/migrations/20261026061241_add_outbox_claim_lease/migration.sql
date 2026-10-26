-- AlterTable
ALTER TABLE "OutBoxEvent" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedUntil" TIMESTAMP(3);

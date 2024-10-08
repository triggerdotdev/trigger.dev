-- CreateEnum
CREATE TYPE "JobRunSubscriptionRecipientMethod" AS ENUM ('WEBHOOK');

-- CreateEnum
CREATE TYPE "JobRunSubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "JobRunSubscriptionEvents" AS ENUM ('SUCCESS', 'FAILURE');

-- AlterTable
ALTER TABLE "EventRecord" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "JobRunSubscription" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientMethod" "JobRunSubscriptionRecipientMethod" NOT NULL DEFAULT 'WEBHOOK',
    "event" "JobRunSubscriptionEvents" NOT NULL,
    "status" "JobRunSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "JobRunSubscription_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "JobRunSubscription" ADD CONSTRAINT "JobRunSubscription_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

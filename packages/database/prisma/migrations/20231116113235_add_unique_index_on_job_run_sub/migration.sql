/*
  Warnings:

  - A unique constraint covering the columns `[runId,recipient,event]` on the table `JobRunSubscription` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "JobRunSubscriptionRecipientMethod" ADD VALUE 'ENDPOINT';

-- CreateIndex
CREATE UNIQUE INDEX "JobRunSubscription_runId_recipient_event_key" ON "JobRunSubscription"("runId", "recipient", "event");

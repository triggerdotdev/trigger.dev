/*
  Warnings:

  - You are about to drop the column `dispatchedAt` on the `EventLog` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "EventLog" DROP COLUMN "dispatchedAt",
ADD COLUMN     "deliveredAt" TIMESTAMP(3);

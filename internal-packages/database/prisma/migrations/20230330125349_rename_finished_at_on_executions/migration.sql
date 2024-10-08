/*
  Warnings:

  - You are about to drop the column `finishedAt` on the `Execution` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Execution" DROP COLUMN "finishedAt",
ADD COLUMN     "completedAt" TIMESTAMP(3);

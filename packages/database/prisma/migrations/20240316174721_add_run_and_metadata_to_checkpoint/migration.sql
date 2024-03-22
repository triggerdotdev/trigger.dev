/*
  Warnings:

  - Added the required column `runId` to the `Checkpoint` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "metadata" TEXT,
ADD COLUMN     "runId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

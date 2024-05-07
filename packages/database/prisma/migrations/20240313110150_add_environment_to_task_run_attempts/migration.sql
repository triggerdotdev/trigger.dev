/*
  Warnings:

  - Added the required column `runtimeEnvironmentId` to the `TaskRunAttempt` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRunAttempt" ADD COLUMN     "runtimeEnvironmentId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/*
 Warnings:
 
 - A unique constraint covering the columns `[runtimeEnvironmentId,idempotencyKey]` on the table `BatchTaskRun` will be added. If there are existing duplicate values, this will fail.
 
 */
-- DropIndex
DROP INDEX "BatchTaskRun_runtimeEnvironmentId_taskIdentifier_idempotenc_key";

-- AlterTable
ALTER TABLE
  "BatchTaskRun"
ADD
  COLUMN "runCount" INTEGER NOT NULL DEFAULT 0,
ADD
  COLUMN "runIds" TEXT [] DEFAULT ARRAY [] :: TEXT [],
ALTER COLUMN
  "taskIdentifier" DROP NOT NULL;
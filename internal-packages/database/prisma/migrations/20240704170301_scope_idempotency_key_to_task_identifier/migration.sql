/*
 Warnings:
 
 - A unique constraint covering the columns `[runtimeEnvironmentId,taskIdentifier,idempotencyKey]` on the table `BatchTaskRun` will be added. If there are existing duplicate values, this will fail.
 - A unique constraint covering the columns `[runtimeEnvironmentId,taskIdentifier,idempotencyKey]` on the table `TaskRun` will be added. If there are existing duplicate values, this will fail.
 
 */
-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_runtimeEnvironmentId_taskIdentifier_idempotenc_key" ON "BatchTaskRun"(
  "runtimeEnvironmentId",
  "taskIdentifier",
  "idempotencyKey"
);

-- DropIndex
DROP INDEX "BatchTaskRun_runtimeEnvironmentId_idempotencyKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_runtimeEnvironmentId_taskIdentifier_idempotencyKey_key" ON "TaskRun"(
  "runtimeEnvironmentId",
  "taskIdentifier",
  "idempotencyKey"
);

-- DropIndex
DROP INDEX "TaskRun_runtimeEnvironmentId_idempotencyKey_key";
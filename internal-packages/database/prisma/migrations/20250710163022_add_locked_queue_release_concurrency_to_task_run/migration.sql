-- DropIndex
DROP INDEX "SecretStore_key_idx";

-- DropIndex
DROP INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx";

-- DropIndex
DROP INDEX "TaskRun_runtimeEnvironmentId_id_idx";

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "lockedQueueReleaseConcurrencyOnWaitpoint" BOOLEAN;

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

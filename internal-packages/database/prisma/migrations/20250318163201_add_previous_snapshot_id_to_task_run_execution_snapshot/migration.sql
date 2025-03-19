-- DropIndex
DROP INDEX "SecretStore_key_idx";

-- AlterTable
ALTER TABLE "TaskRunExecutionSnapshot" ADD COLUMN     "previousSnapshotId" TEXT;

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "SecretStore"("key" text_pattern_ops);

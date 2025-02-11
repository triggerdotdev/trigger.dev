-- AlterEnum
ALTER TYPE "BatchTaskRunStatus" ADD VALUE 'ABORTED';

-- DropIndex
DROP INDEX "SecretStore_key_idx";

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "SecretStore"("key" text_pattern_ops);

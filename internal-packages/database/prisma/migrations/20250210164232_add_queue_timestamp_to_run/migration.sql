-- DropIndex
DROP INDEX "SecretStore_key_idx";

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "queueTimestamp" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "SecretStore"("key" text_pattern_ops);

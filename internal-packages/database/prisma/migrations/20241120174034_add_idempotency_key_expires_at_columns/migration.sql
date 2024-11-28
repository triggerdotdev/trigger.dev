-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "idempotencyKeyExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "idempotencyKeyExpiresAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "IdempotencyKeyScope" AS ENUM ('RUN', 'ATTEMPT', 'GLOBAL');

-- AlterTable
ALTER TABLE "TaskRun"
ADD COLUMN "userIdempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "TaskRun"
ADD COLUMN "idempotencyKeyScope" "IdempotencyKeyScope";
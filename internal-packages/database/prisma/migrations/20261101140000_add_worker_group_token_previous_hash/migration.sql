-- AlterTable
ALTER TABLE "WorkerGroupToken" ADD COLUMN IF NOT EXISTS "previousTokenHash" TEXT;
ALTER TABLE "WorkerGroupToken" ADD COLUMN IF NOT EXISTS "previousTokenValidUntil" TIMESTAMP(3);

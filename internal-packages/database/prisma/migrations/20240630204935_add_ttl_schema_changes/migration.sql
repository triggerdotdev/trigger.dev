-- AlterEnum
ALTER TYPE "TaskRunStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "ttl" TEXT;

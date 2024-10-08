-- CreateEnum
CREATE TYPE "BatchTaskRunStatus" AS ENUM ('PENDING', 'COMPLETED');

-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "status" "BatchTaskRunStatus" NOT NULL DEFAULT 'PENDING';

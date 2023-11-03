-- CreateEnum
CREATE TYPE "TaskChildExecutionMode" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "childExecutionMode" "TaskChildExecutionMode" NOT NULL DEFAULT 'SEQUENTIAL';

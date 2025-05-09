-- CreateEnum
CREATE TYPE "TaskQueueVersion" AS ENUM ('V1', 'V2');

-- AlterTable
ALTER TABLE
  "TaskQueue"
ADD
  COLUMN "orderableName" TEXT,
ADD
  COLUMN "version" "TaskQueueVersion" NOT NULL DEFAULT 'V1';
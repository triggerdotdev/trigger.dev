-- CreateEnum
CREATE TYPE "TaskQueueConcurrencyVersion" AS ENUM ('V1', 'V2');

-- CreateEnum
CREATE TYPE "TaskQueueRole" AS ENUM ('QUEUE', 'LIMIT');

-- AlterTable
ALTER TABLE "TaskQueue" ADD COLUMN "concurrencyVersion" "TaskQueueConcurrencyVersion" NOT NULL DEFAULT 'V1',
ADD COLUMN "role" "TaskQueueRole" NOT NULL DEFAULT 'QUEUE';

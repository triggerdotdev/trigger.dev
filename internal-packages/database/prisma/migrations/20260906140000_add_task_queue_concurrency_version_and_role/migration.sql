-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskQueueConcurrencyVersion" AS ENUM ('V1', 'V2');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskQueueRole" AS ENUM ('QUEUE', 'LIMIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "TaskQueue" ADD COLUMN IF NOT EXISTS "concurrencyVersion" "TaskQueueConcurrencyVersion" NOT NULL DEFAULT 'V1',
ADD COLUMN IF NOT EXISTS "role" "TaskQueueRole" NOT NULL DEFAULT 'QUEUE';

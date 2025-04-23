-- AlterTable
ALTER TABLE
  "TaskQueue"
ADD
  COLUMN "releaseConcurrencyOnWaitpoint" BOOLEAN NOT NULL DEFAULT false;
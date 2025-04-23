-- AlterTable
ALTER TABLE
  "TaskRun"
ADD
  COLUMN "taskEventStore" TEXT NOT NULL DEFAULT 'taskEvent';
-- DropForeignKey
ALTER TABLE
  "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_scheduleId_fkey";

-- DropForeignKey
ALTER TABLE
  "TaskRun" DROP CONSTRAINT IF EXISTS "TaskRun_scheduleInstanceId_fkey";
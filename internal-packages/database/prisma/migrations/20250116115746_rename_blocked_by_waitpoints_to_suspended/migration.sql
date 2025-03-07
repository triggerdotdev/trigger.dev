/*
  Warnings:

  - The values [BLOCKED_BY_WAITPOINTS] on the enum `TaskRunExecutionStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "TaskRunExecutionStatus_new" AS ENUM ('RUN_CREATED', 'QUEUED', 'PENDING_EXECUTING', 'EXECUTING', 'EXECUTING_WITH_WAITPOINTS', 'SUSPENDED', 'PENDING_CANCEL', 'FINISHED');
ALTER TABLE "TaskRunExecutionSnapshot" ALTER COLUMN "executionStatus" TYPE "TaskRunExecutionStatus_new" USING ("executionStatus"::text::"TaskRunExecutionStatus_new");
ALTER TYPE "TaskRunExecutionStatus" RENAME TO "TaskRunExecutionStatus_old";
ALTER TYPE "TaskRunExecutionStatus_new" RENAME TO "TaskRunExecutionStatus";
DROP TYPE "TaskRunExecutionStatus_old";
COMMIT;

/*
  Warnings:

  - The values [INTERRUPTED] on the enum `WorkflowRunStatus` will be removed. If these variants are still used in the database, this will fail.

*/

UPDATE "WorkflowRun" SET "status" = 'DISCONNECTED' WHERE "status" = 'INTERRUPTED';

-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowRunStatus_new" AS ENUM ('PENDING', 'RUNNING', 'DISCONNECTED', 'SUCCESS', 'ERROR');
ALTER TABLE "WorkflowRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WorkflowRun" ALTER COLUMN "status" TYPE "WorkflowRunStatus_new" USING ("status"::text::"WorkflowRunStatus_new");
ALTER TYPE "WorkflowRunStatus" RENAME TO "WorkflowRunStatus_old";
ALTER TYPE "WorkflowRunStatus_new" RENAME TO "WorkflowRunStatus";
DROP TYPE "WorkflowRunStatus_old";
ALTER TABLE "WorkflowRun" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

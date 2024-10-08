/*
  Warnings:

  - The values [ARCHIVED] on the enum `WorkflowStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowStatus_new" AS ENUM ('CREATED', 'READY', 'DISABLED');
ALTER TABLE "Workflow" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Workflow" ALTER COLUMN "status" TYPE "WorkflowStatus_new" USING ("status"::text::"WorkflowStatus_new");
ALTER TYPE "WorkflowStatus" RENAME TO "WorkflowStatus_old";
ALTER TYPE "WorkflowStatus_new" RENAME TO "WorkflowStatus";
DROP TYPE "WorkflowStatus_old";
ALTER TABLE "Workflow" ALTER COLUMN "status" SET DEFAULT 'CREATED';
COMMIT;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false;

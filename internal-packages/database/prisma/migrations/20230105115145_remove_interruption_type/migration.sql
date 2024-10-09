/*
  Warnings:

  - The values [INTERRUPTION] on the enum `WorkflowRunStepType` will be removed. If these variants are still used in the database, this will fail.

*/

UPDATE "WorkflowRunStep" SET "type" = 'DISCONNECTION' WHERE "type" = 'INTERRUPTION';

-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowRunStepType_new" AS ENUM ('OUTPUT', 'LOG_MESSAGE', 'DURABLE_DELAY', 'CUSTOM_EVENT', 'INTEGRATION_REQUEST', 'DISCONNECTION');
ALTER TABLE "WorkflowRunStep" ALTER COLUMN "type" TYPE "WorkflowRunStepType_new" USING ("type"::text::"WorkflowRunStepType_new");
ALTER TYPE "WorkflowRunStepType" RENAME TO "WorkflowRunStepType_old";
ALTER TYPE "WorkflowRunStepType_new" RENAME TO "WorkflowRunStepType";
DROP TYPE "WorkflowRunStepType_old";
COMMIT;

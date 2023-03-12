/*
  Warnings:

  - The values [KEY_VALUE] on the enum `WorkflowRunStepType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowRunStepType_new" AS ENUM ('OUTPUT', 'LOG_MESSAGE', 'DURABLE_DELAY', 'CUSTOM_EVENT', 'INTEGRATION_REQUEST', 'DISCONNECTION', 'FETCH_REQUEST', 'RUN_ONCE', 'KV_GET', 'KV_SET', 'KV_DELETE');
ALTER TABLE "WorkflowRunStep" ALTER COLUMN "type" TYPE "WorkflowRunStepType_new" USING ("type"::text::"WorkflowRunStepType_new");
ALTER TYPE "WorkflowRunStepType" RENAME TO "WorkflowRunStepType_old";
ALTER TYPE "WorkflowRunStepType_new" RENAME TO "WorkflowRunStepType";
DROP TYPE "WorkflowRunStepType_old";
COMMIT;

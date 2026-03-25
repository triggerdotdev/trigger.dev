-- DropForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" DROP CONSTRAINT IF EXISTS "TaskRunExecutionSnapshot_batchId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" DROP CONSTRAINT IF EXISTS "TaskRunExecutionSnapshot_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" DROP CONSTRAINT IF EXISTS "TaskRunExecutionSnapshot_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" DROP CONSTRAINT IF EXISTS "TaskRunExecutionSnapshot_projectId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" DROP CONSTRAINT IF EXISTS "TaskRunExecutionSnapshot_workerId_fkey";

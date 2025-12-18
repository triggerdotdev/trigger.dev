-- AlterEnum
ALTER TYPE "public"."TaskRunExecutionStatus" ADD VALUE 'DELAYED';

-- AlterTable
ALTER TABLE "public"."TaskRun" ADD COLUMN     "debounce" JSONB;
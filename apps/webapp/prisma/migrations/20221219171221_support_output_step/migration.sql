-- AlterEnum
ALTER TYPE "WorkflowRunStepType" ADD VALUE 'OUTPUT';

-- AlterTable
ALTER TABLE "WorkflowRunStep" ALTER COLUMN "input" DROP NOT NULL;

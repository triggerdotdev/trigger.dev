-- DropIndex
DROP INDEX "idx_jobrun_jobid_createdat";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "deletedAt" TIMESTAMP(3);

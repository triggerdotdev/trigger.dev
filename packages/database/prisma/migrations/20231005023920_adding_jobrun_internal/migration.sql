-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

-- Update 'internal' in 'JobRun' based on 'internal' in 'Job'
UPDATE "JobRun"
SET "internal" = "Job"."internal"
FROM "Job"
WHERE "JobRun"."jobId" = "Job"."id";

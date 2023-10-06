-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

/*
  Backfill JobRun internal flag
*/
UPDATE "JobRun"
SET "internal" = "Job"."internal"
FROM "Job"
WHERE "JobRun"."jobId" = "Job"."id" AND "JobRun"."internal" = TRUE;

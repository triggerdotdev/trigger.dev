UPDATE "JobRun"
SET "internal" = "Job"."internal"
FROM "Job"
WHERE "JobRun"."jobId" = "Job"."id";
-- This is an empty migration.
INSERT INTO
  "JobCounter" ("jobId", "lastNumber")
SELECT
  "jobId",
  MAX(number)
FROM
  "JobRun"
GROUP BY
  "jobId";
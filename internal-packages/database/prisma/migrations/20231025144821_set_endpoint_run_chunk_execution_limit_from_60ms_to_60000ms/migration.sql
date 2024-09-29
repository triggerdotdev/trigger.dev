-- This updates any Endpoint runChunkExecutionLimit that were 60ms to be 60000ms
UPDATE "Endpoint"
SET
  "runChunkExecutionLimit" = 60000
WHERE
  "runChunkExecutionLimit" = 60;
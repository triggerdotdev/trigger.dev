-- Partial unique index (Prisma cannot express the WHERE clause, so it is SQL-only). Mirrors the
-- control-plane `TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_null_key`: without it the
-- composite (taskRunId, waitpointId, batchIndex) index treats NULL batchIndex rows as distinct, so
-- blockRunWithWaitpointEdges' ON CONFLICT DO NOTHING cannot dedupe a re-blocked NULL-batchIndex edge.
CREATE UNIQUE INDEX "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_null_key" ON "public"."TaskRunWaitpoint"("taskRunId", "waitpointId") WHERE "batchIndex" IS NULL;

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EnvironmentVariableValue_valueReferenceId_idx" ON "public"."EnvironmentVariableValue"("valueReferenceId");

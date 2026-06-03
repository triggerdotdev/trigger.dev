-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EnvironmentVariableValue_environmentId_idx"
  ON "EnvironmentVariableValue"("environmentId");

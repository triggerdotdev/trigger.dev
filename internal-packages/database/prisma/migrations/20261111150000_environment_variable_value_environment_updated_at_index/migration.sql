-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EnvironmentVariableValue_environmentId_updatedAt_variableId_idx" ON "EnvironmentVariableValue"("environmentId", "updatedAt" DESC, "variableId");

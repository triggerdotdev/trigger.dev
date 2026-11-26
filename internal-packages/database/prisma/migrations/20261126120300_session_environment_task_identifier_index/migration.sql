-- CreateIndex: whether a task has had a session in an environment (the task sidebar's Sessions section)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_runtimeEnvironmentId_taskIdentifier_idx" ON "Session"("runtimeEnvironmentId", "taskIdentifier");

-- CreateIndex
CREATE INDEX "TaskRun_projectId_idx" ON "TaskRun"("projectId");

-- CreateIndex
CREATE INDEX "TaskRun_projectId_taskIdentifier_idx" ON "TaskRun"("projectId", "taskIdentifier");

-- CreateIndex
CREATE INDEX "TaskRun_projectId_status_idx" ON "TaskRun"("projectId", "status");

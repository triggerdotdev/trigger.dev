-- CreateIndex
CREATE INDEX "TaskRun_projectId_taskIdentifier_status_idx" ON "TaskRun"("projectId", "taskIdentifier", "status");

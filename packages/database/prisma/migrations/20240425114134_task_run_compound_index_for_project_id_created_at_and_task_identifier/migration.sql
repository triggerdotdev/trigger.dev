-- CreateIndex
CREATE INDEX "TaskRun_projectId_createdAt_taskIdentifier_idx" ON "TaskRun"("projectId", "createdAt", "taskIdentifier");

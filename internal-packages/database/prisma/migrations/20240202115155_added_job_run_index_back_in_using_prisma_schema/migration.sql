-- CreateIndex
CREATE INDEX "idx_jobrun_jobId_createdAt" ON "JobRun"("jobId", "createdAt" DESC);

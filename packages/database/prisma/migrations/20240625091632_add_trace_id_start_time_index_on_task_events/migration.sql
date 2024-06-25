-- CreateIndex
CREATE INDEX "TaskEvent_traceId_startTime_idx" ON "TaskEvent"("traceId", "startTime");

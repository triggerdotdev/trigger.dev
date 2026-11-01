-- CreateIndex
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "WorkerGroupToken_previousTokenHash_key" ON "WorkerGroupToken"("previousTokenHash");

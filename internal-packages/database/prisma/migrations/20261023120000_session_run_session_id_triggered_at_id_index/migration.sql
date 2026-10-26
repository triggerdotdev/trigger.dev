-- CreateIndex: pages a session's runs by (triggeredAt, id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SessionRun_sessionId_triggeredAt_id_idx" ON "SessionRun"("sessionId", "triggeredAt", "id");

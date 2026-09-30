-- Index the SET NULL foreign key so deleting a user doesn't scan SupportAccessRequest.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SupportAccessRequest_requestedById_idx" ON "SupportAccessRequest"("requestedById");

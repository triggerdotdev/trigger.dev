-- Index the SET NULL foreign key so deleting a user doesn't scan SupportAccessRequest.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SupportAccessRequest_approvedById_idx" ON "SupportAccessRequest"("approvedById");

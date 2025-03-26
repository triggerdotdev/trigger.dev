-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_createdAt_idx" ON "Waitpoint" ("environmentId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_status_idx" ON "Waitpoint" ("environmentId", "type", "status");
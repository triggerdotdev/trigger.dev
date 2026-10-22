-- Backs the build env vars retention sweep. Prisma cannot declare the partial predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkerDeployment_createdAt_idx" ON "WorkerDeployment"("createdAt") WHERE "buildEnvVars" IS NOT NULL;

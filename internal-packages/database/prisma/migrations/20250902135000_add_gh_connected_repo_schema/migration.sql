CREATE TABLE "public"."ConnectedGithubRepository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "branchTracking" JSONB NOT NULL,
    "previewDeploymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedGithubRepository_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConnectedGithubRepository_repositoryId_idx" ON "public"."ConnectedGithubRepository"("repositoryId");

CREATE UNIQUE INDEX "ConnectedGithubRepository_projectId_key" ON "public"."ConnectedGithubRepository"("projectId");

ALTER TABLE "public"."ConnectedGithubRepository" ADD CONSTRAINT "ConnectedGithubRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."ConnectedGithubRepository" ADD CONSTRAINT "ConnectedGithubRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "public"."GithubRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

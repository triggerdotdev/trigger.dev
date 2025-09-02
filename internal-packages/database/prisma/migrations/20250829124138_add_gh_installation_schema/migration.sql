CREATE TYPE "public"."GithubRepositorySelection" AS ENUM ('ALL', 'SELECTED');

CREATE TABLE "public"."GithubAppInstallation" (
    "id" TEXT NOT NULL,
    "appInstallationId" INTEGER NOT NULL,
    "targetId" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "accountHandle" TEXT NOT NULL,
    "permissions" JSONB,
    "repositorySelection" "public"."GithubRepositorySelection" NOT NULL,
    "installedBy" TEXT,
    "organizationId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubAppInstallation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."GithubRepository" (
    "id" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubRepository_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GithubAppInstallation_appInstallationId_key" ON "public"."GithubAppInstallation"("appInstallationId");

CREATE INDEX "GithubAppInstallation_organizationId_idx" ON "public"."GithubAppInstallation"("organizationId");

CREATE INDEX "GithubRepository_installationId_idx" ON "public"."GithubRepository"("installationId");

CREATE UNIQUE INDEX "GithubRepository_installationId_githubId_key" ON "public"."GithubRepository"("installationId", "githubId");

ALTER TABLE "public"."GithubAppInstallation" ADD CONSTRAINT "GithubAppInstallation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."GithubRepository" ADD CONSTRAINT "GithubRepository_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "public"."GithubAppInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

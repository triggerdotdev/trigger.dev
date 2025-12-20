-- CreateEnum
CREATE TYPE "public"."CustomerQuerySource" AS ENUM ('DASHBOARD', 'API');

-- CreateEnum
CREATE TYPE "public"."CustomerQueryScope" AS ENUM ('ORGANIZATION', 'PROJECT', 'ENVIRONMENT');

-- CreateTable
CREATE TABLE
    "public"."CustomerQuery" (
        "id" TEXT NOT NULL,
        "query" TEXT NOT NULL,
        "scope" "public"."CustomerQueryScope" NOT NULL,
        "stats" JSONB NOT NULL,
        "costInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "source" "public"."CustomerQuerySource" NOT NULL DEFAULT 'DASHBOARD',
        "organizationId" TEXT NOT NULL,
        "projectId" TEXT,
        "environmentId" TEXT,
        "userId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CustomerQuery_pkey" PRIMARY KEY ("id")
    );

-- CreateIndex
CREATE INDEX "CustomerQuery_organizationId_createdAt_idx" ON "public"."CustomerQuery" ("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CustomerQuery_createdAt_idx" ON "public"."CustomerQuery" ("createdAt");

-- AddForeignKey
ALTER TABLE "public"."CustomerQuery" ADD CONSTRAINT "CustomerQuery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuery" ADD CONSTRAINT "CustomerQuery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuery" ADD CONSTRAINT "CustomerQuery_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CustomerQuery" ADD CONSTRAINT "CustomerQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
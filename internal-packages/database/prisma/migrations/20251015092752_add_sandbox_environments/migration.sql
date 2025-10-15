-- CreateEnum
CREATE TYPE "public"."SandboxStatus" AS ENUM ('PENDING', 'DEPLOYING', 'DEPLOYED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "public"."SandboxType" AS ENUM ('PROVISIONED', 'PROGRAMMATIC');

-- AlterEnum
ALTER TYPE "public"."TaskTriggerSource" ADD VALUE 'SANDBOX';

-- AlterTable
ALTER TABLE "public"."BackgroundWorkerTask" ADD COLUMN     "sandboxEnvironmentId" TEXT;

-- CreateTable
CREATE TABLE "public"."SandboxEnvironment" (
    "id" TEXT NOT NULL,
    "type" "public"."SandboxType" NOT NULL DEFAULT 'PROVISIONED',
    "friendlyId" TEXT NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "packages" TEXT[],
    "systemPackages" TEXT[],
    "runtime" TEXT NOT NULL,
    "imageReference" TEXT,
    "imageVersion" TEXT,
    "contentHash" TEXT,
    "status" "public"."SandboxStatus" NOT NULL DEFAULT 'PENDING',
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SandboxEnvironment_friendlyId_key" ON "public"."SandboxEnvironment"("friendlyId");

-- CreateIndex
CREATE INDEX "SandboxEnvironment_runtimeEnvironmentId_idx" ON "public"."SandboxEnvironment"("runtimeEnvironmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxEnvironment_runtimeEnvironmentId_deduplicationKey_key" ON "public"."SandboxEnvironment"("runtimeEnvironmentId", "deduplicationKey");

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_sandboxEnvironmentId_fkey" FOREIGN KEY ("sandboxEnvironmentId") REFERENCES "public"."SandboxEnvironment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SandboxEnvironment" ADD CONSTRAINT "SandboxEnvironment_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

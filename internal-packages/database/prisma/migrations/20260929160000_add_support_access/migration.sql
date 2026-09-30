-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SupportAccessMode') THEN
    CREATE TYPE "public"."SupportAccessMode" AS ENUM ('ALLOW', 'REQUIRES_REQUEST');
  END IF;
END $$;

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SupportAccessRequestStatus') THEN
    CREATE TYPE "public"."SupportAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'CANCELLED');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "public"."Organization"
  ADD COLUMN IF NOT EXISTS "supportAccessMode" "public"."SupportAccessMode" NOT NULL DEFAULT 'ALLOW',
  ADD COLUMN IF NOT EXISTS "supportAccessModeUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "supportAccessModeUpdatedById" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."SupportAccessRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT,
    "reason" TEXT NOT NULL,
    "status" "public"."SupportAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportAccessRequest_organizationId_status_expiresAt_idx" ON "public"."SupportAccessRequest"("organizationId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "public"."SupportAccessRequest" DROP CONSTRAINT IF EXISTS "SupportAccessRequest_organizationId_fkey", ADD CONSTRAINT "SupportAccessRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupportAccessRequest" DROP CONSTRAINT IF EXISTS "SupportAccessRequest_requestedById_fkey", ADD CONSTRAINT "SupportAccessRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupportAccessRequest" DROP CONSTRAINT IF EXISTS "SupportAccessRequest_approvedById_fkey", ADD CONSTRAINT "SupportAccessRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

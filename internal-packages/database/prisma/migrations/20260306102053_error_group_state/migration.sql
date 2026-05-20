-- CreateEnum
CREATE TYPE "public"."ErrorGroupStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'IGNORED');

-- AlterEnum
ALTER TYPE "public"."ProjectAlertType" ADD VALUE IF NOT EXISTS 'ERROR_GROUP';

-- CreateTable
CREATE TABLE
    "public"."ErrorGroupState" (
        "id" TEXT NOT NULL,
        "organizationId" TEXT NOT NULL,
        "projectId" TEXT NOT NULL,
        "environmentId" TEXT,
        "taskIdentifier" TEXT NOT NULL,
        "errorFingerprint" TEXT NOT NULL,
        "status" "public"."ErrorGroupStatus" NOT NULL DEFAULT 'UNRESOLVED',
        "ignoredUntil" TIMESTAMP(3),
        "ignoredUntilOccurrenceRate" INTEGER,
        "ignoredUntilTotalOccurrences" INTEGER,
        "ignoredAtOccurrenceCount" BIGINT,
        "ignoredAt" TIMESTAMP(3),
        "ignoredReason" TEXT,
        "ignoredByUserId" TEXT,
        "resolvedAt" TIMESTAMP(3),
        "resolvedInVersion" TEXT,
        "resolvedBy" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "ErrorGroupState_pkey" PRIMARY KEY ("id")
    );

-- CreateIndex
CREATE UNIQUE INDEX "ErrorGroupState_environmentId_taskIdentifier_errorFingerpri_key" ON "public"."ErrorGroupState" (
    "environmentId",
    "taskIdentifier",
    "errorFingerprint"
);

-- CreateIndex
CREATE INDEX "ErrorGroupState_environmentId_status_idx" ON "public"."ErrorGroupState" ("environmentId", "status");

-- AddForeignKey
ALTER TABLE "public"."ErrorGroupState" ADD CONSTRAINT "ErrorGroupState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ErrorGroupState" ADD CONSTRAINT "ErrorGroupState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ErrorGroupState" ADD CONSTRAINT "ErrorGroupState_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "public"."ProjectAlertChannel"
ADD COLUMN "errorAlertConfig" JSONB;
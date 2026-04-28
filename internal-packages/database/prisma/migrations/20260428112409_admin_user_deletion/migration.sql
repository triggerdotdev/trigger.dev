-- DropForeignKey
ALTER TABLE "public"."MfaBackupCode" DROP CONSTRAINT "MfaBackupCode_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PersonalAccessToken" DROP CONSTRAINT "PersonalAccessToken_userId_fkey";

-- CreateTable
CREATE TABLE "public"."UserDeletionAuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "targetEmail" TEXT NOT NULL,
    "softDeletedOrgIds" TEXT[],
    "reason" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDeletionAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDeletionAuditLog_adminUserId_idx" ON "public"."UserDeletionAuditLog"("adminUserId");

-- CreateIndex
CREATE INDEX "UserDeletionAuditLog_targetUserId_idx" ON "public"."UserDeletionAuditLog"("targetUserId");

-- CreateIndex
CREATE INDEX "UserDeletionAuditLog_createdAt_idx" ON "public"."UserDeletionAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."MfaBackupCode" ADD CONSTRAINT "MfaBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

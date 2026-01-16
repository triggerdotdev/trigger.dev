-- CreateEnum
CREATE TYPE "public"."ImpersonationAuditLogAction" AS ENUM ('START', 'STOP');

-- CreateTable
CREATE TABLE "public"."ImpersonationAuditLog" (
    "id" TEXT NOT NULL,
    "action" "public"."ImpersonationAuditLogAction" NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpersonationAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImpersonationAuditLog_adminId_idx" ON "public"."ImpersonationAuditLog"("adminId");

-- CreateIndex
CREATE INDEX "ImpersonationAuditLog_targetId_idx" ON "public"."ImpersonationAuditLog"("targetId");

-- CreateIndex
CREATE INDEX "ImpersonationAuditLog_createdAt_idx" ON "public"."ImpersonationAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."ImpersonationAuditLog" ADD CONSTRAINT "ImpersonationAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ImpersonationAuditLog" ADD CONSTRAINT "ImpersonationAuditLog_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

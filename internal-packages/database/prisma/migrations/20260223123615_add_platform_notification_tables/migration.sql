-- CreateEnum
CREATE TYPE "public"."PlatformNotificationSurface" AS ENUM ('WEBAPP', 'CLI');

-- CreateEnum
CREATE TYPE "public"."PlatformNotificationScope" AS ENUM ('USER', 'PROJECT', 'ORGANIZATION', 'GLOBAL');

-- CreateTable
CREATE TABLE "public"."PlatformNotification" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "surface" "public"."PlatformNotificationSurface" NOT NULL,
    "scope" "public"."PlatformNotificationScope" NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "projectId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "cliMaxDaysAfterFirstSeen" INTEGER,
    "cliMaxShowCount" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatformNotificationInteraction" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "showCount" INTEGER NOT NULL DEFAULT 1,
    "webappDismissedAt" TIMESTAMP(3),
    "cliDismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformNotificationInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformNotification_friendlyId_key" ON "public"."PlatformNotification"("friendlyId");

-- CreateIndex
CREATE INDEX "PlatformNotification_surface_scope_startsAt_idx" ON "public"."PlatformNotification"("surface", "scope", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformNotificationInteraction_notificationId_userId_key" ON "public"."PlatformNotificationInteraction"("notificationId", "userId");

-- AddForeignKey
ALTER TABLE "public"."PlatformNotification" ADD CONSTRAINT "PlatformNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatformNotification" ADD CONSTRAINT "PlatformNotification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatformNotification" ADD CONSTRAINT "PlatformNotification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatformNotificationInteraction" ADD CONSTRAINT "PlatformNotificationInteraction_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "public"."PlatformNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatformNotificationInteraction" ADD CONSTRAINT "PlatformNotificationInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

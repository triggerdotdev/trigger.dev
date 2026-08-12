-- CreateEnum
CREATE TYPE "OrganizationSupportChannelStatus" AS ENUM ('PENDING', 'PROVISIONING', 'INVITED', 'FAILED', 'LINKED');

-- CreateTable
CREATE TABLE "OrganizationSupportChannel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "OrganizationSupportChannelStatus" NOT NULL DEFAULT 'PENDING',
    "slackChannelId" TEXT,
    "slackChannelName" TEXT,
    "inviteUrl" TEXT,
    "invitedEmail" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSupportChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSupportChannel_organizationId_key" ON "OrganizationSupportChannel"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSupportChannel_slackChannelId_key" ON "OrganizationSupportChannel"("slackChannelId");

-- AddForeignKey
ALTER TABLE "OrganizationSupportChannel" ADD CONSTRAINT "OrganizationSupportChannel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

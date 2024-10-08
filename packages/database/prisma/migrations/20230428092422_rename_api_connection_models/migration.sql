/*
  Warnings:

  - You are about to drop the `APIConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `APIConnectionAttempt` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "APIConnection" DROP CONSTRAINT "APIConnection_dataReferenceId_fkey";

-- DropForeignKey
ALTER TABLE "APIConnection" DROP CONSTRAINT "APIConnection_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "APIConnectionAttempt" DROP CONSTRAINT "APIConnectionAttempt_apiConnectionId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalService" DROP CONSTRAINT "ExternalService_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalSource" DROP CONSTRAINT "ExternalSource_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "HttpSource" DROP CONSTRAINT "HttpSource_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "JobConnection" DROP CONSTRAINT "JobConnection_apiConnectionId_fkey";

-- DropTable
DROP TABLE "APIConnection";

-- DropTable
DROP TABLE "APIConnectionAttempt";

-- CreateTable
CREATE TABLE "ApiConnection" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "apiIdentifier" TEXT NOT NULL,
    "authenticationMethodKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL,
    "dataReferenceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "ApiConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiConnectionAttempt" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "apiIdentifier" TEXT NOT NULL,
    "authenticationMethodKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "securityCode" TEXT,
    "redirectTo" TEXT NOT NULL DEFAULT '/',
    "apiConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiConnectionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiConnection_dataReferenceId_key" ON "ApiConnection"("dataReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiConnection_organizationId_slug_key" ON "ApiConnection"("organizationId", "slug");

-- AddForeignKey
ALTER TABLE "ApiConnection" ADD CONSTRAINT "ApiConnection_dataReferenceId_fkey" FOREIGN KEY ("dataReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnection" ADD CONSTRAINT "ApiConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnectionAttempt" ADD CONSTRAINT "ApiConnectionAttempt_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "ApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ApiConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalService" ADD CONSTRAINT "ExternalService_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ApiConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobConnection" ADD CONSTRAINT "JobConnection_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "ApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

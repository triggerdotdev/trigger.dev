/*
  Warnings:

  - You are about to drop the column `apiConnectionClientId` on the `JobIntegration` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `JobIntegration` table. All the data in the column will be lost.
  - You are about to drop the column `apiConnectionId` on the `RunConnection` table. All the data in the column will be lost.
  - You are about to drop the column `apiClientId` on the `TriggerSource` table. All the data in the column will be lost.
  - You are about to drop the `ApiConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ApiConnectionAttempt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ApiConnectionClient` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MissingApiConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_JobRunToMissingApiConnection` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `integrationId` to the `JobIntegration` table without a default value. This is not possible if the table is not empty.
  - Added the required column `connectionId` to the `RunConnection` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "IntegrationAuthSource" AS ENUM ('HOSTED', 'LOCAL');

-- CreateEnum
CREATE TYPE "ConnectionType" AS ENUM ('EXTERNAL', 'DEVELOPER');

-- DropForeignKey
ALTER TABLE "ApiConnection" DROP CONSTRAINT "ApiConnection_clientId_fkey";

-- DropForeignKey
ALTER TABLE "ApiConnection" DROP CONSTRAINT "ApiConnection_dataReferenceId_fkey";

-- DropForeignKey
ALTER TABLE "ApiConnection" DROP CONSTRAINT "ApiConnection_externalAccountId_fkey";

-- DropForeignKey
ALTER TABLE "ApiConnection" DROP CONSTRAINT "ApiConnection_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ApiConnectionAttempt" DROP CONSTRAINT "ApiConnectionAttempt_clientId_fkey";

-- DropForeignKey
ALTER TABLE "ApiConnectionClient" DROP CONSTRAINT "ApiConnectionClient_customClientReferenceId_fkey";

-- DropForeignKey
ALTER TABLE "ApiConnectionClient" DROP CONSTRAINT "ApiConnectionClient_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "JobIntegration" DROP CONSTRAINT "JobIntegration_apiConnectionClientId_fkey";

-- DropForeignKey
ALTER TABLE "MissingApiConnection" DROP CONSTRAINT "MissingApiConnection_apiConnectionClientId_fkey";

-- DropForeignKey
ALTER TABLE "MissingApiConnection" DROP CONSTRAINT "MissingApiConnection_externalAccountId_fkey";

-- DropForeignKey
ALTER TABLE "RunConnection" DROP CONSTRAINT "RunConnection_apiConnectionId_fkey";

-- DropForeignKey
ALTER TABLE "TriggerSource" DROP CONSTRAINT "TriggerSource_apiClientId_fkey";

-- DropForeignKey
ALTER TABLE "_JobRunToMissingApiConnection" DROP CONSTRAINT "_JobRunToMissingApiConnection_A_fkey";

-- DropForeignKey
ALTER TABLE "_JobRunToMissingApiConnection" DROP CONSTRAINT "_JobRunToMissingApiConnection_B_fkey";

-- AlterTable
ALTER TABLE "JobIntegration" DROP COLUMN "apiConnectionClientId",
DROP COLUMN "metadata",
ADD COLUMN     "integrationId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "RunConnection" DROP COLUMN "apiConnectionId",
ADD COLUMN     "connectionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TriggerSource" DROP COLUMN "apiClientId",
ADD COLUMN     "integrationId" TEXT;

-- DropTable
DROP TABLE "ApiConnection";

-- DropTable
DROP TABLE "ApiConnectionAttempt";

-- DropTable
DROP TABLE "ApiConnectionClient";

-- DropTable
DROP TABLE "MissingApiConnection";

-- DropTable
DROP TABLE "_JobRunToMissingApiConnection";

-- DropEnum
DROP TYPE "ApiConnectionType";

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "metadata" JSONB NOT NULL,
    "authSource" "IntegrationAuthSource" NOT NULL DEFAULT 'HOSTED',
    "authenticationDefinition" JSONB,
    "connectionType" "ConnectionType" NOT NULL DEFAULT 'DEVELOPER',
    "scopes" TEXT[],
    "customClientReferenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL,
    "scopes" TEXT[],
    "dataReferenceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionType" "ConnectionType" NOT NULL DEFAULT 'DEVELOPER',
    "externalAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionAttempt" (
    "id" TEXT NOT NULL,
    "securityCode" TEXT,
    "redirectTo" TEXT NOT NULL DEFAULT '/',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "integrationId" TEXT NOT NULL,

    CONSTRAINT "ConnectionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissingConnection" (
    "id" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "integrationId" TEXT NOT NULL,
    "connectionType" "ConnectionType" NOT NULL DEFAULT 'DEVELOPER',
    "externalAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MissingConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_JobRunToMissingConnection" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_slug_key" ON "Integration"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "MissingConnection_integrationId_connectionType_externalAcco_key" ON "MissingConnection"("integrationId", "connectionType", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "_JobRunToMissingConnection_AB_unique" ON "_JobRunToMissingConnection"("A", "B");

-- CreateIndex
CREATE INDEX "_JobRunToMissingConnection_B_index" ON "_JobRunToMissingConnection"("B");

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_customClientReferenceId_fkey" FOREIGN KEY ("customClientReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_dataReferenceId_fkey" FOREIGN KEY ("dataReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionAttempt" ADD CONSTRAINT "ConnectionAttempt_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobIntegration" ADD CONSTRAINT "JobIntegration_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunConnection" ADD CONSTRAINT "RunConnection_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissingConnection" ADD CONSTRAINT "MissingConnection_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissingConnection" ADD CONSTRAINT "MissingConnection_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobRunToMissingConnection" ADD CONSTRAINT "_JobRunToMissingConnection_A_fkey" FOREIGN KEY ("A") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobRunToMissingConnection" ADD CONSTRAINT "_JobRunToMissingConnection_B_fkey" FOREIGN KEY ("B") REFERENCES "MissingConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

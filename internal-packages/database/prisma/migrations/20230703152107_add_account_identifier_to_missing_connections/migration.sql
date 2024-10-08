/*
  Warnings:

  - A unique constraint covering the columns `[integrationId,connectionType,accountIdentifier]` on the table `MissingConnection` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "MissingConnection" ADD COLUMN     "accountIdentifier" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MissingConnection_integrationId_connectionType_accountIdent_key" ON "MissingConnection"("integrationId", "connectionType", "accountIdentifier");

/*
  Warnings:

  - You are about to drop the column `authenticationDefinition` on the `Integration` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Integration" DROP COLUMN "authenticationDefinition",
ADD COLUMN     "authMethodId" TEXT;

-- CreateTable
CREATE TABLE "IntegrationAuthMethod" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "client" JSONB,
    "config" JSONB,
    "scopes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAuthMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAuthMethod_identifier_key_key" ON "IntegrationAuthMethod"("identifier", "key");

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_authMethodId_fkey" FOREIGN KEY ("authMethodId") REFERENCES "IntegrationAuthMethod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

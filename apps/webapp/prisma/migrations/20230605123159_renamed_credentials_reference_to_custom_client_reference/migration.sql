/*
  Warnings:

  - You are about to drop the column `credentialsReferenceId` on the `ApiConnectionClient` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ApiConnectionClient" DROP CONSTRAINT "ApiConnectionClient_credentialsReferenceId_fkey";

-- AlterTable
ALTER TABLE "ApiConnectionClient" DROP COLUMN "credentialsReferenceId",
ADD COLUMN     "clientType" "ApiConnectionType" NOT NULL DEFAULT 'DEVELOPER',
ADD COLUMN     "customClientReferenceId" TEXT;

-- AddForeignKey
ALTER TABLE "ApiConnectionClient" ADD CONSTRAINT "ApiConnectionClient_customClientReferenceId_fkey" FOREIGN KEY ("customClientReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

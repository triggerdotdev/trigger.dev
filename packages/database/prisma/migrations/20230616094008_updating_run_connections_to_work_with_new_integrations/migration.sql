/*
  Warnings:

  - Added the required column `integrationId` to the `RunConnection` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RunConnection" ADD COLUMN     "authSource" "IntegrationAuthSource" NOT NULL DEFAULT 'HOSTED',
ADD COLUMN     "integrationId" TEXT NOT NULL,
ALTER COLUMN "connectionId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "RunConnection" ADD CONSTRAINT "RunConnection_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

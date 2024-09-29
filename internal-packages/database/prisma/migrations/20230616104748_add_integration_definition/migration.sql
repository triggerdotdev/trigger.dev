/*
  Warnings:

  - You are about to drop the column `icon` on the `Integration` table. All the data in the column will be lost.
  - Added the required column `definitionId` to the `Integration` table without a default value. This is not possible if the table is not empty.
  - Added the required column `definitionId` to the `IntegrationAuthMethod` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Integration" DROP COLUMN "icon",
ADD COLUMN     "definitionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "IntegrationAuthMethod" ADD COLUMN     "definitionId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "IntegrationDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT,

    CONSTRAINT "IntegrationDefinition_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "IntegrationAuthMethod" ADD CONSTRAINT "IntegrationAuthMethod_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "IntegrationDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "IntegrationDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

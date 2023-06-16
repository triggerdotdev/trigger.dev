/*
  Warnings:

  - You are about to drop the column `identifier` on the `IntegrationAuthMethod` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[definitionId,key]` on the table `IntegrationAuthMethod` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "IntegrationAuthMethod_identifier_key_key";

-- AlterTable
ALTER TABLE "IntegrationAuthMethod" DROP COLUMN "identifier";

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAuthMethod_definitionId_key_key" ON "IntegrationAuthMethod"("definitionId", "key");

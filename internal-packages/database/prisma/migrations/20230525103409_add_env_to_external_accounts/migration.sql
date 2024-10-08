/*
  Warnings:

  - A unique constraint covering the columns `[environmentId,identifier]` on the table `ExternalAccount` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `environmentId` to the `ExternalAccount` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "ExternalAccount_organizationId_identifier_key";

-- AlterTable
ALTER TABLE "ExternalAccount" ADD COLUMN     "environmentId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAccount_environmentId_identifier_key" ON "ExternalAccount"("environmentId", "identifier");

-- AddForeignKey
ALTER TABLE "ExternalAccount" ADD CONSTRAINT "ExternalAccount_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

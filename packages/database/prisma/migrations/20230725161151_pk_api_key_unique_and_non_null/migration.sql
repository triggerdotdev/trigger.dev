/*
  Warnings:

  - A unique constraint covering the columns `[pkApiKey]` on the table `RuntimeEnvironment` will be added. If there are existing duplicate values, this will fail.
  - Made the column `pkApiKey` on table `RuntimeEnvironment` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "RuntimeEnvironment" ALTER COLUMN "pkApiKey" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEnvironment_pkApiKey_key" ON "RuntimeEnvironment"("pkApiKey");

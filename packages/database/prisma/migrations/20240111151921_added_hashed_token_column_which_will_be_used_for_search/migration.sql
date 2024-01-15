/*
  Warnings:

  - A unique constraint covering the columns `[hashedToken]` on the table `PersonalAccessToken` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `hashedToken` to the `PersonalAccessToken` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "PersonalAccessToken" ADD COLUMN     "hashedToken" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccessToken_hashedToken_key" ON "PersonalAccessToken"("hashedToken");

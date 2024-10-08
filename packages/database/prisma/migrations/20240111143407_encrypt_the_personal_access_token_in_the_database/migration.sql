/*
  Warnings:

  - You are about to drop the column `token` on the `PersonalAccessToken` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[encryptedToken]` on the table `PersonalAccessToken` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `encryptedToken` to the `PersonalAccessToken` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "PersonalAccessToken_token_key";

-- AlterTable
ALTER TABLE "PersonalAccessToken" DROP COLUMN "token",
ADD COLUMN     "encryptedToken" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccessToken_encryptedToken_key" ON "PersonalAccessToken"("encryptedToken");

/*
  Warnings:

  - Added the required column `obfuscatedToken` to the `PersonalAccessToken` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `encryptedToken` on the `PersonalAccessToken` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropIndex
DROP INDEX "PersonalAccessToken_encryptedToken_key";

-- AlterTable
ALTER TABLE "PersonalAccessToken" ADD COLUMN     "obfuscatedToken" TEXT NOT NULL,
DROP COLUMN "encryptedToken",
ADD COLUMN     "encryptedToken" JSONB NOT NULL;

/*
  Warnings:

  - You are about to drop the column `schema` on the `ApiConnectionClient` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ApiConnectionClient" DROP COLUMN "schema",
ADD COLUMN     "integrationAuthMethod" TEXT NOT NULL DEFAULT 'oauth2';

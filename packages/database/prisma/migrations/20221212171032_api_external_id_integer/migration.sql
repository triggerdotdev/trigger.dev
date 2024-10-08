/*
  Warnings:

  - The `externalId` column on the `APIConnection` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "APIConnection" DROP COLUMN "externalId",
ADD COLUMN     "externalId" INTEGER;

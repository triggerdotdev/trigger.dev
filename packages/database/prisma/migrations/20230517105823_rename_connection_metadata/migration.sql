/*
  Warnings:

  - You are about to drop the column `connectionMetadata` on the `JobIntegration` table. All the data in the column will be lost.
  - Added the required column `metadata` to the `JobIntegration` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobIntegration" DROP COLUMN "connectionMetadata",
ADD COLUMN     "metadata" JSONB NOT NULL;

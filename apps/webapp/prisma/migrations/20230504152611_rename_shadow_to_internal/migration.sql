/*
  Warnings:

  - You are about to drop the column `shadow` on the `Job` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Job" DROP COLUMN "shadow",
ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

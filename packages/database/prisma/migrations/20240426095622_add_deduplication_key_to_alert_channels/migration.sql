/*
  Warnings:

  - The required column `deduplicationKey` was added to the `ProjectAlertChannel` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "ProjectAlertChannel" ADD COLUMN     "deduplicationKey" TEXT NOT NULL,
ADD COLUMN     "userProvidedDeduplicationKey" BOOLEAN NOT NULL DEFAULT false;

/*
  Warnings:

  - Added the required column `trigger` to the `EventRule` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EventRule" ADD COLUMN     "trigger" JSONB NOT NULL;

/*
  Warnings:

  - Added the required column `title` to the `APIConnectionAttempt` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "APIConnectionAttempt" ADD COLUMN     "title" TEXT NOT NULL;

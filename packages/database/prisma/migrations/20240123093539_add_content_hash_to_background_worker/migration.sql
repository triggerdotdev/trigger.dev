/*
  Warnings:

  - Added the required column `contentHash` to the `BackgroundWorker` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "BackgroundWorker" ADD COLUMN     "contentHash" TEXT NOT NULL;

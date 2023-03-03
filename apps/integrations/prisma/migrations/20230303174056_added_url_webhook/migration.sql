/*
  Warnings:

  - Added the required column `url` to the `Webhook` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "url" TEXT NOT NULL;

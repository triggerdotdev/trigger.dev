/*
  Warnings:

  - Added the required column `secret` to the `RegisteredWebhook` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RegisteredWebhook" ADD COLUMN     "secret" TEXT NOT NULL;

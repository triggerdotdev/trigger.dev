/*
  Warnings:

  - Added the required column `service` to the `TriggerEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TriggerEvent" ADD COLUMN     "service" TEXT NOT NULL;

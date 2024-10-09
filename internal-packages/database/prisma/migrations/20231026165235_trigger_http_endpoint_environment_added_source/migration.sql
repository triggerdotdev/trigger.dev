/*
  Warnings:

  - Added the required column `source` to the `TriggerHttpEndpointEnvironment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TriggerHttpEndpointEnvironment" ADD COLUMN     "source" TEXT NOT NULL;

/*
  Warnings:

  - Added the required column `location` to the `JobRunAutoYieldExecution` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobRunAutoYieldExecution" ADD COLUMN     "location" TEXT NOT NULL;

/*
  Warnings:

  - Added the required column `displayKey` to the `Task` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "displayKey" TEXT NOT NULL,
ADD COLUMN     "icon" TEXT;

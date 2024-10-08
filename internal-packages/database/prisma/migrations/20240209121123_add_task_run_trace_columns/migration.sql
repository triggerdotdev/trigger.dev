/*
  Warnings:

  - Added the required column `spanId` to the `TaskRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `traceId` to the `TaskRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "spanId" TEXT NOT NULL,
ADD COLUMN     "traceId" TEXT NOT NULL;

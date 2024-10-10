/*
  Warnings:

  - Added the required column `output` to the `TaskRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "error" TEXT,
ADD COLUMN     "output" TEXT NOT NULL,
ADD COLUMN     "outputType" TEXT NOT NULL DEFAULT 'JSON';

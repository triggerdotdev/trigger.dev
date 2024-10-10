/*
  Warnings:

  - The `error` column on the `TaskRunAttempt` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "TaskRunAttempt" DROP COLUMN "error",
ADD COLUMN     "error" JSONB;

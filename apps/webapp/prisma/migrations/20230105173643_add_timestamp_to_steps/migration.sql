/*
  Warnings:

  - Added the required column `timestamp` to the `WorkflowRunStep` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WorkflowRunStep" ADD COLUMN     "ts" INTEGER NULL;

-- Add timestamps to existing steps based on the step createdAt (converting to unix timestamp since timestamp is an Integer)
UPDATE "WorkflowRunStep" SET ts = extract(epoch from "createdAt") * 1000;

-- Make timestamp required
ALTER TABLE "WorkflowRunStep" ALTER COLUMN "ts" SET NOT NULL;

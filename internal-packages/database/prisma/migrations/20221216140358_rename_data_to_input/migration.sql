/*
  Warnings:

  - You are about to drop the column `data` on the `WorkflowRun` table. All the data in the column will be lost.
  - Added the required column `input` to the `WorkflowRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WorkflowRun" DROP COLUMN "data",
ADD COLUMN     "input" JSONB NOT NULL;

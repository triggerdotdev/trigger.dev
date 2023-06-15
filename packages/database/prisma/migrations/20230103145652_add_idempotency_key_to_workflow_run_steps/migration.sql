/*
  Warnings:

  - A unique constraint covering the columns `[runId,idempotencyKey]` on the table `WorkflowRunStep` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `idempotencyKey` to the `WorkflowRunStep` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WorkflowRunStep" ADD COLUMN     "idempotencyKey" TEXT NULL;

-- Add random idempotency keys to existing rows
UPDATE "WorkflowRunStep" SET "idempotencyKey" = gen_random_uuid();

-- AlterTable
ALTER TABLE "WorkflowRunStep" ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunStep_runId_idempotencyKey_key" ON "WorkflowRunStep"("runId", "idempotencyKey");

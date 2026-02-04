/*
  Warnings:

  - A unique constraint covering the columns `[batchTaskRunId,index]` on the table `BatchTaskRunError` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRunError_batchTaskRunId_index_key" ON "public"."BatchTaskRunError"("batchTaskRunId", "index");
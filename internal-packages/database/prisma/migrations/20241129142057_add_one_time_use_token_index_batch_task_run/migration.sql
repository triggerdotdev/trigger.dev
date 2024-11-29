/*
 Warnings:
 
 - A unique constraint covering the columns `[oneTimeUseToken]` on the table `BatchTaskRun` will be added. If there are existing duplicate values, this will fail.
 
 */
-- CreateIndex
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "BatchTaskRun_oneTimeUseToken_key" ON "BatchTaskRun"("oneTimeUseToken");
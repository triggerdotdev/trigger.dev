/*
 Warnings:
 
 - A unique constraint covering the columns `[oneTimeUseToken]` on the table `TaskRun` will be added. If there are existing duplicate values, this will fail.
 
 */
-- CreateIndex
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "TaskRun_oneTimeUseToken_key" ON "TaskRun"("oneTimeUseToken");
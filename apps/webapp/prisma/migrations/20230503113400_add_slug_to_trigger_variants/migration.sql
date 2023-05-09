/*
  Warnings:

  - A unique constraint covering the columns `[jobInstanceId,slug]` on the table `JobTriggerVariant` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `JobTriggerVariant` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobTriggerVariant" ADD COLUMN     "slug" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "JobTriggerVariant_jobInstanceId_slug_key" ON "JobTriggerVariant"("jobInstanceId", "slug");

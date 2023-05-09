/*
  Warnings:

  - A unique constraint covering the columns `[jobId,environmentId,name]` on the table `JobAlias` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `environmentId` to the `JobAlias` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "JobAlias_jobId_name_key";

-- AlterTable
ALTER TABLE "JobAlias" ADD COLUMN     "environmentId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "JobAlias_jobId_environmentId_name_key" ON "JobAlias"("jobId", "environmentId", "name");

-- AddForeignKey
ALTER TABLE "JobAlias" ADD CONSTRAINT "JobAlias_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

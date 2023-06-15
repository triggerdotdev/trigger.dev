/*
  Warnings:

  - You are about to drop the column `maxConcurrentRuns` on the `JobInstance` table. All the data in the column will be lost.
  - You are about to drop the column `queueName` on the `JobInstance` table. All the data in the column will be lost.
  - Added the required column `queueId` to the `JobInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `queueId` to the `JobRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobInstance" DROP COLUMN "maxConcurrentRuns",
DROP COLUMN "queueName",
ADD COLUMN     "queueId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "queueId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "JobQueue" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "maxJobs" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "JobQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobQueue_environmentId_name_key" ON "JobQueue"("environmentId", "name");

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "JobQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQueue" ADD CONSTRAINT "JobQueue_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "JobQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

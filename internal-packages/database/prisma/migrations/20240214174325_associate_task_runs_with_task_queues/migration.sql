/*
  Warnings:

  - You are about to drop the column `queue` on the `TaskRun` table. All the data in the column will be lost.
  - Added the required column `queueId` to the `TaskRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRun" DROP COLUMN "queue",
ADD COLUMN     "queueId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "TaskQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

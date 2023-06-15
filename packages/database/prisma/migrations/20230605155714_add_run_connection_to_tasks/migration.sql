/*
  Warnings:

  - You are about to drop the column `connectionKey` on the `Task` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Task" DROP COLUMN "connectionKey",
ADD COLUMN     "runConnectionId" TEXT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_runConnectionId_fkey" FOREIGN KEY ("runConnectionId") REFERENCES "RunConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

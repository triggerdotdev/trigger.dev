/*
  Warnings:

  - Added the required column `environmentId` to the `TaskRunExecutionSnapshot` table without a default value. This is not possible if the table is not empty.
  - Added the required column `environmentType` to the `TaskRunExecutionSnapshot` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskRunExecutionSnapshot" ADD COLUMN     "environmentId" TEXT NOT NULL,
ADD COLUMN     "environmentType" "RuntimeEnvironmentType" NOT NULL;

-- AddForeignKey
ALTER TABLE "TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

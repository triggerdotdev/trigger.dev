/*
 Warnings:
 
 - Added the required column `organizationId` to the `TaskRunExecutionSnapshot` table without a default value. This is not possible if the table is not empty.
 - Added the required column `projectId` to the `TaskRunExecutionSnapshot` table without a default value. This is not possible if the table is not empty.
 
 */
-- AlterTable
ALTER TABLE
  "TaskRunExecutionSnapshot"
ADD
  COLUMN "organizationId" TEXT NOT NULL,
ADD
  COLUMN "projectId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE
  "TaskRunExecutionSnapshot"
ADD
  CONSTRAINT "TaskRunExecutionSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE
  "TaskRunExecutionSnapshot"
ADD
  CONSTRAINT "TaskRunExecutionSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
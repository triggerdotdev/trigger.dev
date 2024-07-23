/*
  Warnings:

  - You are about to drop the `TaskTag` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_TaskRunToTaskTag` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "TaskTag" DROP CONSTRAINT "TaskTag_projectId_fkey";

-- DropForeignKey
ALTER TABLE "_TaskRunToTaskTag" DROP CONSTRAINT "_TaskRunToTaskTag_A_fkey";

-- DropForeignKey
ALTER TABLE "_TaskRunToTaskTag" DROP CONSTRAINT "_TaskRunToTaskTag_B_fkey";

-- DropTable
DROP TABLE "TaskTag";

-- DropTable
DROP TABLE "_TaskRunToTaskTag";

-- CreateTable
CREATE TABLE "TaskRunTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskRunTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_TaskRunToTaskRunTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunTag_friendlyId_key" ON "TaskRunTag"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunTag_projectId_name_key" ON "TaskRunTag"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "_TaskRunToTaskRunTag_AB_unique" ON "_TaskRunToTaskRunTag"("A", "B");

-- CreateIndex
CREATE INDEX "_TaskRunToTaskRunTag_B_index" ON "_TaskRunToTaskRunTag"("B");

-- AddForeignKey
ALTER TABLE "TaskRunTag" ADD CONSTRAINT "TaskRunTag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_A_fkey" FOREIGN KEY ("A") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_B_fkey" FOREIGN KEY ("B") REFERENCES "TaskRunTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

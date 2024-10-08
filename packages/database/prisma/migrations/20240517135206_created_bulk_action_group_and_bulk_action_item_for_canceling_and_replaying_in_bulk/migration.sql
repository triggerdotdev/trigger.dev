-- CreateEnum
CREATE TYPE "BulkActionType" AS ENUM ('CANCEL', 'REPLAY');

-- CreateEnum
CREATE TYPE "BulkActionStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BulkActionItemStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateTable
CREATE TABLE "BulkActionGroup" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "BulkActionType" NOT NULL,
    "status" "BulkActionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkActionItem" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "type" "BulkActionType" NOT NULL,
    "status" "BulkActionItemStatus" NOT NULL DEFAULT 'PENDING',
    "sourceRunId" TEXT,
    "destinationRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BulkActionGroup_friendlyId_key" ON "BulkActionGroup"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BulkActionItem_friendlyId_key" ON "BulkActionItem"("friendlyId");

-- AddForeignKey
ALTER TABLE "BulkActionGroup" ADD CONSTRAINT "BulkActionGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkActionItem" ADD CONSTRAINT "BulkActionItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BulkActionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkActionItem" ADD CONSTRAINT "BulkActionItem_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkActionItem" ADD CONSTRAINT "BulkActionItem_destinationRunId_fkey" FOREIGN KEY ("destinationRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

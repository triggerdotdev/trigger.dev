-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "lockedToVersionId" TEXT;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_lockedToVersionId_fkey" FOREIGN KEY ("lockedToVersionId") REFERENCES "BackgroundWorker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

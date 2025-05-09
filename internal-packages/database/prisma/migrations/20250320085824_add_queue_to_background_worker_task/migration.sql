-- AlterTable
ALTER TABLE
  "BackgroundWorkerTask"
ADD
  COLUMN "queueId" TEXT,
ALTER COLUMN
  "exportName" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE
  "BackgroundWorkerTask"
ADD
  CONSTRAINT "BackgroundWorkerTask_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "TaskQueue"("id") ON DELETE
SET
  NULL ON UPDATE CASCADE;
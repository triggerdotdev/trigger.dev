-- CreateTable
CREATE TABLE "_BackgroundWorkerToTaskQueue" ("A" TEXT NOT NULL, "B" TEXT NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "_BackgroundWorkerToTaskQueue_AB_unique" ON "_BackgroundWorkerToTaskQueue"("A", "B");

-- CreateIndex
CREATE INDEX "_BackgroundWorkerToTaskQueue_B_index" ON "_BackgroundWorkerToTaskQueue"("B");

-- AddForeignKey
ALTER TABLE
  "_BackgroundWorkerToTaskQueue"
ADD
  CONSTRAINT "_BackgroundWorkerToTaskQueue_A_fkey" FOREIGN KEY ("A") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE
  "_BackgroundWorkerToTaskQueue"
ADD
  CONSTRAINT "_BackgroundWorkerToTaskQueue_B_fkey" FOREIGN KEY ("B") REFERENCES "TaskQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
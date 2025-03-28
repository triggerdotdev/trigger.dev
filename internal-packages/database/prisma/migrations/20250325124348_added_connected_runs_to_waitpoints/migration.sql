-- CreateTable
CREATE TABLE
    "_WaitpointRunConnections" ("A" TEXT NOT NULL, "B" TEXT NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "_WaitpointRunConnections_AB_unique" ON "_WaitpointRunConnections" ("A", "B");

-- CreateIndex
CREATE INDEX "_WaitpointRunConnections_B_index" ON "_WaitpointRunConnections" ("B");

-- AddForeignKey
ALTER TABLE "_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "TaskRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "Waitpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
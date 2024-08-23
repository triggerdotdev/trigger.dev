-- AlterTable
ALTER TABLE "BackgroundWorkerTask" ADD COLUMN     "fileId" TEXT;

-- CreateTable
CREATE TABLE "BackgroundWorkerFile" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contents" BYTEA NOT NULL,
    "backgroundWorkerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundWorkerFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerFile_friendlyId_key" ON "BackgroundWorkerFile"("friendlyId");

-- AddForeignKey
ALTER TABLE "BackgroundWorkerFile" ADD CONSTRAINT "BackgroundWorkerFile_backgroundWorkerId_fkey" FOREIGN KEY ("backgroundWorkerId") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "BackgroundWorkerFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

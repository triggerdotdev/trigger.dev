-- CreateTable
CREATE TABLE "JobConnection" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "jobInstanceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "connectionMetadata" JSONB NOT NULL,
    "apiConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobConnection_jobInstanceId_key_key" ON "JobConnection"("jobInstanceId", "key");

-- AddForeignKey
ALTER TABLE "JobConnection" ADD CONSTRAINT "JobConnection_jobInstanceId_fkey" FOREIGN KEY ("jobInstanceId") REFERENCES "JobInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobConnection" ADD CONSTRAINT "JobConnection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobConnection" ADD CONSTRAINT "JobConnection_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "APIConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

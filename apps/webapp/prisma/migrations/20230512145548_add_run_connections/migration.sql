-- CreateTable
CREATE TABLE "RunConnection" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "apiConnectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunConnection_runId_key_key" ON "RunConnection"("runId", "key");

-- AddForeignKey
ALTER TABLE "RunConnection" ADD CONSTRAINT "RunConnection_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunConnection" ADD CONSTRAINT "RunConnection_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "ApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

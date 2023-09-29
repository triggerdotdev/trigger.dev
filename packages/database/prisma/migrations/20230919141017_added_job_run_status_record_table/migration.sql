-- CreateTable
CREATE TABLE "JobRunStatusRecord" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "state" TEXT,
    "data" JSONB,
    "history" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRunStatusRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobRunStatusRecord_runId_key_key" ON "JobRunStatusRecord"("runId", "key");

-- AddForeignKey
ALTER TABLE "JobRunStatusRecord" ADD CONSTRAINT "JobRunStatusRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

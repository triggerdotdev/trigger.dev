-- CreateTable
CREATE TABLE "RealtimeStreamChunk" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "runId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RealtimeStreamChunk_pkey" PRIMARY KEY ("id")
);

-- Add index on (runID, createdAt) for efficient queries
CREATE INDEX "RealtimeStreamChunk_runId" ON "RealtimeStreamChunk" ("runId");
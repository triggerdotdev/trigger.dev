-- AlterTable
ALTER TABLE "Session"
    ADD COLUMN "currentRunId"      TEXT,
    ADD COLUMN "currentRunVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "triggerConfig"     JSONB NOT NULL,
    ALTER COLUMN "taskIdentifier" SET NOT NULL;

-- CreateTable
CREATE TABLE "SessionRun" (
    "id"          TEXT NOT NULL,
    "sessionId"   TEXT NOT NULL,
    "runId"       TEXT NOT NULL,
    "reason"      TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionRun_runId_key"
    ON "SessionRun"("runId");

-- CreateIndex
CREATE INDEX "SessionRun_sessionId_idx"
    ON "SessionRun"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionRun"
    ADD CONSTRAINT "SessionRun_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

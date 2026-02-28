-- CreateEnum
CREATE TYPE "public"."DeadLetterStatus" AS ENUM ('PENDING', 'RETRIED', 'DISCARDED');

-- CreateTable
CREATE TABLE "public"."DeadLetterEvent" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "taskSlug" TEXT NOT NULL,
    "failedRunId" TEXT NOT NULL,
    "error" JSONB,
    "attemptCount" INTEGER NOT NULL,
    "status" "public"."DeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "sourceEventId" TEXT,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterEvent_friendlyId_key" ON "public"."DeadLetterEvent"("friendlyId");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_projectId_environmentId_status_idx" ON "public"."DeadLetterEvent"("projectId", "environmentId", "status");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_eventType_environmentId_idx" ON "public"."DeadLetterEvent"("eventType", "environmentId");

-- AddForeignKey
ALTER TABLE "public"."DeadLetterEvent" ADD CONSTRAINT "DeadLetterEvent_failedRunId_fkey" FOREIGN KEY ("failedRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeadLetterEvent" ADD CONSTRAINT "DeadLetterEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeadLetterEvent" ADD CONSTRAINT "DeadLetterEvent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "CheckpointRestoreEventType" AS ENUM ('CHECKPOINT', 'RESTORE');

-- CreateTable
CREATE TABLE "CheckpointRestoreEvent" (
    "id" TEXT NOT NULL,
    "type" "CheckpointRestoreEventType" NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "checkpointId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckpointRestoreEvent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

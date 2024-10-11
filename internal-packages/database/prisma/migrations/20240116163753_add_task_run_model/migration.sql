-- CreateEnum
CREATE TYPE "TaskRunStatus" AS ENUM ('PENDING', 'EXECUTING', 'PAUSED', 'FAILED', 'CANCELED', 'COMPLETED');

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "payloadType" TEXT NOT NULL DEFAULT 'JSON',
    "context" JSONB,
    "status" "TaskRunStatus" NOT NULL DEFAULT 'PENDING',
    "runtimeEnvironmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "backgroundWorkerId" TEXT,
    "backgroundWorkerTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_externalRef_key" ON "TaskRun"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_runtimeEnvironmentId_idempotencyKey_key" ON "TaskRun"("runtimeEnvironmentId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_backgroundWorkerId_fkey" FOREIGN KEY ("backgroundWorkerId") REFERENCES "BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_backgroundWorkerTaskId_fkey" FOREIGN KEY ("backgroundWorkerTaskId") REFERENCES "BackgroundWorkerTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TaskIdentifier" (
    "id" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "currentTriggerSource" "TaskTriggerSource" NOT NULL DEFAULT 'STANDARD',
    "currentWorkerId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isInLatestDeployment" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaskIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskIdentifier_runtimeEnvironmentId_slug_key"
    ON "TaskIdentifier"("runtimeEnvironmentId", "slug");

-- CreateIndex
CREATE INDEX "TaskIdentifier_runtimeEnvironmentId_isInLatestDeployment_idx"
    ON "TaskIdentifier"("runtimeEnvironmentId", "isInLatestDeployment");

-- AddForeignKey
ALTER TABLE "TaskIdentifier"
    ADD CONSTRAINT "TaskIdentifier_runtimeEnvironmentId_fkey"
    FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskIdentifier"
    ADD CONSTRAINT "TaskIdentifier_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskIdentifier"
    ADD CONSTRAINT "TaskIdentifier_currentWorkerId_fkey"
    FOREIGN KEY ("currentWorkerId") REFERENCES "BackgroundWorker"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

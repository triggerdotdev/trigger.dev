-- CreateTable
CREATE TABLE "TaskSchedule" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "userProvidedDeduplicationKey" BOOLEAN NOT NULL DEFAULT false,
    "cron" TEXT NOT NULL,
    "externalId" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskScheduleInstance" (
    "id" TEXT NOT NULL,
    "taskScheduleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskScheduleInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskSchedule_friendlyId_key" ON "TaskSchedule"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSchedule_projectId_deduplicationKey_key" ON "TaskSchedule"("projectId", "deduplicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "TaskScheduleInstance_taskScheduleId_environmentId_key" ON "TaskScheduleInstance"("taskScheduleId", "environmentId");

-- AddForeignKey
ALTER TABLE "TaskSchedule" ADD CONSTRAINT "TaskSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskScheduleInstance" ADD CONSTRAINT "TaskScheduleInstance_taskScheduleId_fkey" FOREIGN KEY ("taskScheduleId") REFERENCES "TaskSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskScheduleInstance" ADD CONSTRAINT "TaskScheduleInstance_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

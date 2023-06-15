-- CreateTable
CREATE TABLE "ScheduleSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "schedule" JSONB NOT NULL,
    "environmentId" TEXT NOT NULL,
    "dispatcherId" TEXT NOT NULL,
    "lastEventTimestamp" TIMESTAMP(3),
    "workerJobId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleSource_key_environmentId_key" ON "ScheduleSource"("key", "environmentId");

-- AddForeignKey
ALTER TABLE "ScheduleSource" ADD CONSTRAINT "ScheduleSource_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSource" ADD CONSTRAINT "ScheduleSource_dispatcherId_fkey" FOREIGN KEY ("dispatcherId") REFERENCES "EventDispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "DeferredScheduledEventService" (
    "id" TEXT NOT NULL,
    "scheduleSourceId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "lastTimestamp" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeferredScheduledEventService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeferredScheduledEventService_scheduleSourceId_key" ON "DeferredScheduledEventService"("scheduleSourceId");

-- AddForeignKey
ALTER TABLE "DeferredScheduledEventService" ADD CONSTRAINT "DeferredScheduledEventService_scheduleSourceId_fkey" FOREIGN KEY ("scheduleSourceId") REFERENCES "ScheduleSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

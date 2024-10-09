-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "scheduleId" TEXT,
ADD COLUMN     "scheduleInstanceId" TEXT;

-- AlterTable
ALTER TABLE "TaskSchedule" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TaskScheduleInstance" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastScheduledTimestamp" TIMESTAMP(3),
ADD COLUMN     "nextScheduledTimestamp" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_scheduleInstanceId_fkey" FOREIGN KEY ("scheduleInstanceId") REFERENCES "TaskScheduleInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TaskSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

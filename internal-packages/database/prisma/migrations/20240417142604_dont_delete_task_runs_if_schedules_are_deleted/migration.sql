-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_scheduleId_fkey";

-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_scheduleInstanceId_fkey";

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_scheduleInstanceId_fkey" FOREIGN KEY ("scheduleInstanceId") REFERENCES "TaskScheduleInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TaskSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

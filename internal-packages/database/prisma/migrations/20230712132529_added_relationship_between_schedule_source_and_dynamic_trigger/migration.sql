-- AlterTable
ALTER TABLE "ScheduleSource" ADD COLUMN     "dynamicTriggerId" TEXT;

-- AddForeignKey
ALTER TABLE "ScheduleSource" ADD CONSTRAINT "ScheduleSource_dynamicTriggerId_fkey" FOREIGN KEY ("dynamicTriggerId") REFERENCES "DynamicTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

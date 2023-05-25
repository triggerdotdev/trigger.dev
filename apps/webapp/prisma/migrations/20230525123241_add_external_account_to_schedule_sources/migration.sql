-- AlterTable
ALTER TABLE "ScheduleSource" ADD COLUMN     "externalAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "ScheduleSource" ADD CONSTRAINT "ScheduleSource_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

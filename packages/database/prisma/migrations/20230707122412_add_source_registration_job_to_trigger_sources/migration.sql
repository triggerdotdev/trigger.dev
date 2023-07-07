-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "sourceRegistrationJobId" TEXT;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_sourceRegistrationJobId_fkey" FOREIGN KEY ("sourceRegistrationJobId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "DynamicTrigger" ADD COLUMN     "sourceRegistrationJobId" TEXT;

-- AddForeignKey
ALTER TABLE "DynamicTrigger" ADD CONSTRAINT "DynamicTrigger_sourceRegistrationJobId_fkey" FOREIGN KEY ("sourceRegistrationJobId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

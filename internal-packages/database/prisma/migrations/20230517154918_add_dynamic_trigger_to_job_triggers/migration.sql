-- AlterTable
ALTER TABLE "JobTrigger" ADD COLUMN     "dynamicTriggerId" TEXT;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_dynamicTriggerId_fkey" FOREIGN KEY ("dynamicTriggerId") REFERENCES "DynamicTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

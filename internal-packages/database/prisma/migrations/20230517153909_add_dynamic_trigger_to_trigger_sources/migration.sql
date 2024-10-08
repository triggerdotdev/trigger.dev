-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "dynamicTriggerId" TEXT;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_dynamicTriggerId_fkey" FOREIGN KEY ("dynamicTriggerId") REFERENCES "DynamicTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

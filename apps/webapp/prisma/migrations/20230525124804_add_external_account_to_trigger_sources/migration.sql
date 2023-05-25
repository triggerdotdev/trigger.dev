-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "externalAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

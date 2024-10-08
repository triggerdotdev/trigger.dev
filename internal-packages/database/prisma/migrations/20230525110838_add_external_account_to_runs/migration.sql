-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "externalAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

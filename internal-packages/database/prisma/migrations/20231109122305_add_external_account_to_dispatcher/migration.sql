-- AlterTable
ALTER TABLE "EventDispatcher" ADD COLUMN     "externalAccountId" TEXT;

-- AddForeignKey
ALTER TABLE "EventDispatcher" ADD CONSTRAINT "EventDispatcher_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

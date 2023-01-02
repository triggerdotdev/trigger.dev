-- DropForeignKey
ALTER TABLE "ExternalService" DROP CONSTRAINT "ExternalService_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalSource" DROP CONSTRAINT "ExternalSource_connectionId_fkey";

-- AddForeignKey
ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "APIConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalService" ADD CONSTRAINT "ExternalService_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "APIConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

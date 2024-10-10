-- AlterTable
ALTER TABLE "HttpSource" ADD COLUMN     "connectionId" TEXT;

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "APIConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "EventRecord" ADD COLUMN     "httpEndpointEnvironmentId" TEXT,
ADD COLUMN     "httpEndpointId" TEXT;

-- AddForeignKey
ALTER TABLE "EventRecord" ADD CONSTRAINT "EventRecord_httpEndpointId_fkey" FOREIGN KEY ("httpEndpointId") REFERENCES "TriggerHttpEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRecord" ADD CONSTRAINT "EventRecord_httpEndpointEnvironmentId_fkey" FOREIGN KEY ("httpEndpointEnvironmentId") REFERENCES "TriggerHttpEndpointEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

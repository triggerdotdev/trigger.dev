-- CreateTable
CREATE TABLE "HttpSourceRequestDelivery" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "body" BYTEA,
    "sourceId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "HttpSourceRequestDelivery_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "HttpSourceRequestDelivery" ADD CONSTRAINT "HttpSourceRequestDelivery_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "HttpSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSourceRequestDelivery" ADD CONSTRAINT "HttpSourceRequestDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSourceRequestDelivery" ADD CONSTRAINT "HttpSourceRequestDelivery_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

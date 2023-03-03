-- CreateTable
CREATE TABLE "Destination" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "destinationSecret" TEXT NOT NULL,
    "destinationData" JSONB,
    "destinationEvent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Destination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Destination_destinationUrl_key" ON "Destination"("destinationUrl");

-- AddForeignKey
ALTER TABLE "Destination" ADD CONSTRAINT "Destination_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

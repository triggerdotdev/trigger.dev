-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "params" JSONB,
    "config" JSONB,
    "desiredConfig" JSONB,
    "httpEndpointId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyValueItem" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyValueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_httpEndpointId_key" ON "Webhook"("httpEndpointId");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_key_projectId_key" ON "Webhook"("key", "projectId");

-- CreateIndex
CREATE INDEX "KeyValueItem_key_idx" ON "KeyValueItem" USING HASH ("key");

-- CreateIndex
CREATE UNIQUE INDEX "KeyValueItem_environmentId_key_key" ON "KeyValueItem"("environmentId", "key");

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_httpEndpointId_fkey" FOREIGN KEY ("httpEndpointId") REFERENCES "TriggerHttpEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyValueItem" ADD CONSTRAINT "KeyValueItem_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "DynamicTriggerRegistration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dynamicTriggerId" TEXT NOT NULL,
    "eventDispatcherId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DynamicTriggerRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DynamicTriggerRegistration_key_dynamicTriggerId_key" ON "DynamicTriggerRegistration"("key", "dynamicTriggerId");

-- AddForeignKey
ALTER TABLE "DynamicTriggerRegistration" ADD CONSTRAINT "DynamicTriggerRegistration_dynamicTriggerId_fkey" FOREIGN KEY ("dynamicTriggerId") REFERENCES "DynamicTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DynamicTriggerRegistration" ADD CONSTRAINT "DynamicTriggerRegistration_eventDispatcherId_fkey" FOREIGN KEY ("eventDispatcherId") REFERENCES "EventDispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DynamicTriggerRegistration" ADD CONSTRAINT "DynamicTriggerRegistration_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TriggerSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

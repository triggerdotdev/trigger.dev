-- CreateTable
CREATE TABLE "RegisteredWebhook" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "connectionSlotId" TEXT NOT NULL,
    "webhookConfig" JSONB NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RegisteredWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredWebhook_triggerId_key" ON "RegisteredWebhook"("triggerId");

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredWebhook_connectionSlotId_key" ON "RegisteredWebhook"("connectionSlotId");

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredWebhook_workflowId_triggerId_key" ON "RegisteredWebhook"("workflowId", "triggerId");

-- AddForeignKey
ALTER TABLE "RegisteredWebhook" ADD CONSTRAINT "RegisteredWebhook_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisteredWebhook" ADD CONSTRAINT "RegisteredWebhook_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "WorkflowTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisteredWebhook" ADD CONSTRAINT "RegisteredWebhook_connectionSlotId_fkey" FOREIGN KEY ("connectionSlotId") REFERENCES "WorkflowConnectionSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

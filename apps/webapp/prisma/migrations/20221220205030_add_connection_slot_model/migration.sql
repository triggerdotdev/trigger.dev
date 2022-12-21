-- CreateTable
CREATE TABLE "WorkflowConnectionSlot" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "triggerId" TEXT,
    "connectionId" TEXT,
    "slotName" TEXT NOT NULL,
    "serviceIdentifier" TEXT NOT NULL,
    "auth" JSONB,

    CONSTRAINT "WorkflowConnectionSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowConnectionSlot_triggerId_key" ON "WorkflowConnectionSlot"("triggerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowConnectionSlot_workflowId_slotName_key" ON "WorkflowConnectionSlot"("workflowId", "slotName");

-- AddForeignKey
ALTER TABLE "WorkflowConnectionSlot" ADD CONSTRAINT "WorkflowConnectionSlot_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowConnectionSlot" ADD CONSTRAINT "WorkflowConnectionSlot_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "WorkflowTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowConnectionSlot" ADD CONSTRAINT "WorkflowConnectionSlot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "APIConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

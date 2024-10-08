-- CreateTable
CREATE TABLE "DynamicTrigger" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,

    CONSTRAINT "DynamicTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_DynamicTriggerToJob" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DynamicTrigger_endpointId_slug_key" ON "DynamicTrigger"("endpointId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "_DynamicTriggerToJob_AB_unique" ON "_DynamicTriggerToJob"("A", "B");

-- CreateIndex
CREATE INDEX "_DynamicTriggerToJob_B_index" ON "_DynamicTriggerToJob"("B");

-- AddForeignKey
ALTER TABLE "DynamicTrigger" ADD CONSTRAINT "DynamicTrigger_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DynamicTriggerToJob" ADD CONSTRAINT "_DynamicTriggerToJob_A_fkey" FOREIGN KEY ("A") REFERENCES "DynamicTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DynamicTriggerToJob" ADD CONSTRAINT "_DynamicTriggerToJob_B_fkey" FOREIGN KEY ("B") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EventDispatchBatcher" (
    "id" TEXT NOT NULL,
    "maxPayloads" INTEGER,
    "maxInterval" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventDispatcherId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "EventDispatchBatcher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventDispatchBatcher_eventDispatcherId_key" ON "EventDispatchBatcher"("eventDispatcherId");

-- AddForeignKey
ALTER TABLE "EventDispatchBatcher" ADD CONSTRAINT "EventDispatchBatcher_eventDispatcherId_fkey" FOREIGN KEY ("eventDispatcherId") REFERENCES "EventDispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDispatchBatcher" ADD CONSTRAINT "EventDispatchBatcher_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

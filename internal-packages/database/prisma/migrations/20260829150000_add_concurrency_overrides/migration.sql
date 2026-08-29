-- AlterTable
ALTER TABLE "TaskQueue" ADD COLUMN "totalConcurrencyLimitOverriddenAt" TIMESTAMP(3);
ALTER TABLE "TaskQueue" ADD COLUMN "totalConcurrencyLimitOverriddenBy" TEXT;
ALTER TABLE "TaskQueue" ADD COLUMN "totalConcurrencyLimitBase" INTEGER;

-- CreateTable
CREATE TABLE "TaskQueueConcurrencyKeyOverride" (
    "id" TEXT NOT NULL,
    "taskQueueId" TEXT NOT NULL,
    "concurrencyKey" TEXT NOT NULL,
    "concurrencyLimit" INTEGER NOT NULL,
    "overriddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overriddenBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskQueueConcurrencyKeyOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskQueueConcurrencyKeyOverride_taskQueueId_concurrencyKey_key" ON "TaskQueueConcurrencyKeyOverride"("taskQueueId", "concurrencyKey");

-- AddForeignKey
ALTER TABLE "TaskQueueConcurrencyKeyOverride" ADD CONSTRAINT "TaskQueueConcurrencyKeyOverride_taskQueueId_fkey" FOREIGN KEY ("taskQueueId") REFERENCES "TaskQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

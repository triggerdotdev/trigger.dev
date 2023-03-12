-- AlterEnum
ALTER TYPE "WorkflowRunStepType" ADD VALUE 'KEY_VALUE';

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
CREATE UNIQUE INDEX "KeyValueItem_environmentId_key_key" ON "KeyValueItem"("environmentId", "key");

-- AddForeignKey
ALTER TABLE "KeyValueItem" ADD CONSTRAINT "KeyValueItem_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

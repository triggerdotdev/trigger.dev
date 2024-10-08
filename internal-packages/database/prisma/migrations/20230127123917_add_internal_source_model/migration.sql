-- CreateEnum
CREATE TYPE "InternalSourceType" AS ENUM ('SLACK');

-- CreateEnum
CREATE TYPE "InternalSourceStatus" AS ENUM ('CREATED', 'READY', 'CANCELLED');

-- CreateTable
CREATE TABLE "InternalSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "type" "InternalSourceType" NOT NULL,
    "source" JSONB NOT NULL,
    "status" "InternalSourceStatus" NOT NULL DEFAULT 'CREATED',
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalSource_workflowId_environmentId_key" ON "InternalSource"("workflowId", "environmentId");

-- AddForeignKey
ALTER TABLE "InternalSource" ADD CONSTRAINT "InternalSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalSource" ADD CONSTRAINT "InternalSource_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalSource" ADD CONSTRAINT "InternalSource_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

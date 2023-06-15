-- CreateEnum
CREATE TYPE "WorkflowTriggerType" AS ENUM ('WEBHOOK', 'SCHEDULE', 'CUSTOM_EVENT', 'HTTP_ENDPOINT');

-- CreateEnum
CREATE TYPE "WorkflowTriggerStatus" AS ENUM ('CREATED', 'CONNECTED');

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "packageJson" JSONB;

-- CreateTable
CREATE TABLE "WorkflowTrigger" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "type" "WorkflowTriggerType" NOT NULL,
    "config" JSONB NOT NULL,
    "status" "WorkflowTriggerStatus" NOT NULL DEFAULT 'CREATED',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorkflowTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTrigger_workflowId_environmentId_key" ON "WorkflowTrigger"("workflowId", "environmentId");

-- AddForeignKey
ALTER TABLE "WorkflowTrigger" ADD CONSTRAINT "WorkflowTrigger_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTrigger" ADD CONSTRAINT "WorkflowTrigger_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "IntegrationRequestStatus" AS ENUM ('PENDING', 'RETRYING', 'SUCCESS', 'ERROR');

-- CreateEnum
CREATE TYPE "WorkflowRunStepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'ERROR');

-- AlterEnum
ALTER TYPE "WorkflowRunStepType" ADD VALUE 'INTEGRATION_REQUEST';

-- AlterTable
ALTER TABLE "WorkflowRunStep" ADD COLUMN     "status" "WorkflowRunStepStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "IntegrationRequest" (
    "id" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "endpoint" TEXT NOT NULL,
    "externalServiceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "IntegrationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "response" JSONB,

    CONSTRAINT "IntegrationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationRequest_stepId_key" ON "IntegrationRequest"("stepId");

-- AddForeignKey
ALTER TABLE "IntegrationRequest" ADD CONSTRAINT "IntegrationRequest_externalServiceId_fkey" FOREIGN KEY ("externalServiceId") REFERENCES "ExternalService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationRequest" ADD CONSTRAINT "IntegrationRequest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationRequest" ADD CONSTRAINT "IntegrationRequest_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowRunStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "ExternalServiceType" AS ENUM ('HTTP_API');

-- CreateEnum
CREATE TYPE "ExternalServiceStatus" AS ENUM ('CREATED', 'READY');

-- CreateTable
CREATE TABLE "ExternalService" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "connectionId" TEXT,
    "type" "ExternalServiceType" NOT NULL,
    "status" "ExternalServiceStatus" NOT NULL DEFAULT 'CREATED',
    "readyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalService_workflowId_slug_key" ON "ExternalService"("workflowId", "slug");

-- AddForeignKey
ALTER TABLE "ExternalService" ADD CONSTRAINT "ExternalService_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalService" ADD CONSTRAINT "ExternalService_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "APIConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

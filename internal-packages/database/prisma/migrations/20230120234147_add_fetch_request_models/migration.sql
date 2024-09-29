-- CreateEnum
CREATE TYPE "FetchRequestStatus" AS ENUM ('PENDING', 'FETCHING', 'RETRYING', 'SUCCESS', 'ERROR');

-- CreateTable
CREATE TABLE "FetchRequest" (
    "id" TEXT NOT NULL,
    "fetch" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "FetchRequestStatus" NOT NULL DEFAULT 'PENDING',
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "response" JSONB,

    CONSTRAINT "FetchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FetchResponse" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FetchResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FetchRequest_stepId_key" ON "FetchRequest"("stepId");

-- AddForeignKey
ALTER TABLE "FetchRequest" ADD CONSTRAINT "FetchRequest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchRequest" ADD CONSTRAINT "FetchRequest_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowRunStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchResponse" ADD CONSTRAINT "FetchResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FetchRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

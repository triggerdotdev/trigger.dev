-- CreateTable
CREATE TABLE "IntegrationResponse" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationResponse_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "IntegrationResponse" ADD CONSTRAINT "IntegrationResponse_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "IntegrationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

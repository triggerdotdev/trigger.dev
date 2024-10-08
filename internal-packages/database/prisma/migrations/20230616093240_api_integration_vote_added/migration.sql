-- CreateTable
CREATE TABLE "ApiIntegrationVote" (
    "id" TEXT NOT NULL,
    "apiIdentifier" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIntegrationVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiIntegrationVote_apiIdentifier_userId_key" ON "ApiIntegrationVote"("apiIdentifier", "userId");

-- AddForeignKey
ALTER TABLE "ApiIntegrationVote" ADD CONSTRAINT "ApiIntegrationVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

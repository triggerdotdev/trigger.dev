-- CreateTable
CREATE TABLE "MissingApiConnection" (
    "id" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "apiConnectionClientId" TEXT NOT NULL,
    "connectionType" "ApiConnectionType" NOT NULL DEFAULT 'DEVELOPER',
    "externalAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MissingApiConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_JobRunToMissingApiConnection" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MissingApiConnection_apiConnectionClientId_connectionType_e_key" ON "MissingApiConnection"("apiConnectionClientId", "connectionType", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "_JobRunToMissingApiConnection_AB_unique" ON "_JobRunToMissingApiConnection"("A", "B");

-- CreateIndex
CREATE INDEX "_JobRunToMissingApiConnection_B_index" ON "_JobRunToMissingApiConnection"("B");

-- AddForeignKey
ALTER TABLE "MissingApiConnection" ADD CONSTRAINT "MissingApiConnection_apiConnectionClientId_fkey" FOREIGN KEY ("apiConnectionClientId") REFERENCES "ApiConnectionClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissingApiConnection" ADD CONSTRAINT "MissingApiConnection_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobRunToMissingApiConnection" ADD CONSTRAINT "_JobRunToMissingApiConnection_A_fkey" FOREIGN KEY ("A") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobRunToMissingApiConnection" ADD CONSTRAINT "_JobRunToMissingApiConnection_B_fkey" FOREIGN KEY ("B") REFERENCES "MissingApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

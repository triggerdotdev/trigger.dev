-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN     "currentSessionId" TEXT;

-- CreateTable
CREATE TABLE "RuntimeEnvironmentSession" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "RuntimeEnvironmentSession_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_currentSessionId_fkey" FOREIGN KEY ("currentSessionId") REFERENCES "RuntimeEnvironmentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeEnvironmentSession" ADD CONSTRAINT "RuntimeEnvironmentSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

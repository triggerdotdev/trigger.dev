/*
  Warnings:

  - Added the required column `metadata` to the `APIConnection` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "APIConnection" ADD COLUMN     "metadata" JSONB NOT NULL,
ADD COLUMN     "scopes" TEXT[];

-- CreateTable
CREATE TABLE "APIConnectionAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "apiIdentifier" TEXT NOT NULL,
    "authenticationMethodKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "redirectTo" TEXT NOT NULL DEFAULT '/',
    "apiConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "APIConnectionAttempt_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "APIConnectionAttempt" ADD CONSTRAINT "APIConnectionAttempt_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "APIConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

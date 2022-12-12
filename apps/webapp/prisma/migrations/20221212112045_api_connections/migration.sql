-- CreateEnum
CREATE TYPE "APIConnectionType" AS ENUM ('HTTP', 'GRAPHQL');

-- CreateTable
CREATE TABLE "APIConnection" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "apiIdentifier" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "scopes" TEXT[],
    "type" "APIConnectionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "APIConnection_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "APIConnection" ADD CONSTRAINT "APIConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

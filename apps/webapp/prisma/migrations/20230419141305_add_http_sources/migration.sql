-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "HttpSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "secret" TEXT,
    "data" JSONB,
    "organizationId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "status" "SourceStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "HttpSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HttpSource_key_organizationId_key" ON "HttpSource"("key", "organizationId");

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

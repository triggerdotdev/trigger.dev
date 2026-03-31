-- CreateEnum
CREATE TYPE "public"."DataStoreKind" AS ENUM ('CLICKHOUSE');

-- CreateTable
CREATE TABLE "public"."OrganizationDataStore" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "organizationIds" TEXT[],
    "kind" "public"."DataStoreKind" NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationDataStore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDataStore_key_key" ON "public"."OrganizationDataStore"("key");

-- CreateIndex
CREATE INDEX "OrganizationDataStore_kind_idx" ON "public"."OrganizationDataStore"("kind");

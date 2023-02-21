-- CreateTable
CREATE TABLE "Cache" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cache_key_key" ON "Cache"("key");

-- CreateIndex
CREATE INDEX "Cache_namespace_key_idx" ON "Cache"("namespace", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Cache_namespace_key_key" ON "Cache"("namespace", "key");

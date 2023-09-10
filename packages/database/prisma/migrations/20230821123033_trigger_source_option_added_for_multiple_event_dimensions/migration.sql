-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "version" TEXT NOT NULL DEFAULT '1';

-- CreateTable
CREATE TABLE "TriggerSourceOption" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "registered" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TriggerSourceOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriggerSourceOption_name_value_sourceId_key" ON "TriggerSourceOption"("name", "value", "sourceId");

-- AddForeignKey
ALTER TABLE "TriggerSourceOption" ADD CONSTRAINT "TriggerSourceOption_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TriggerSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate TriggerSourceEvent to TriggerSourceOption
INSERT INTO "TriggerSourceOption" ("id", "name", "value", "sourceId", "createdAt", "updatedAt", "registered")
SELECT
    "id",
    'event', -- use the literal value "event"
    "name",
    "sourceId",
    "createdAt",
    CURRENT_TIMESTAMP,
    "registered"
FROM "TriggerSourceEvent";
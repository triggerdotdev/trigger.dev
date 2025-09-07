-- AlterTable
ALTER TABLE "WorkerInstanceGroup"
ADD COLUMN "cloudProvider" TEXT,
ADD COLUMN "location" TEXT,
ADD COLUMN "staticIPs" TEXT;
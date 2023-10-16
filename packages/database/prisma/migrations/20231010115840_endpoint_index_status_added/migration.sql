-- CreateEnum
CREATE TYPE "EndpointIndexStatus" AS ENUM ('PENDING', 'STARTED', 'SUCCESS', 'FAILURE');

-- AlterTable
ALTER TABLE "EndpointIndex"
ADD COLUMN "status" "EndpointIndexStatus" NOT NULL DEFAULT 'PENDING';

-- Update all existing rows to be SUCCESS. This isn't correct because some of them have failed, but we don't want them to be PENDING.
UPDATE "EndpointIndex"
SET
  "status" = 'SUCCESS';
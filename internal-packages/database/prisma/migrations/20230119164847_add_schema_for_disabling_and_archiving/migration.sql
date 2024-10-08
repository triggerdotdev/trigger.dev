-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkflowStatus" ADD VALUE 'DISABLED';
ALTER TYPE "WorkflowStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "EventRule" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3);

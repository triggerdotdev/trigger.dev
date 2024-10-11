-- AlterEnum
ALTER TYPE "BulkActionItemStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "BulkActionItem" ADD COLUMN     "error" TEXT;

-- AlterTable
ALTER TABLE "BatchTaskRun" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expectedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sealed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sealedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BatchTaskRunItem" ADD COLUMN     "completedAt" TIMESTAMP(3);

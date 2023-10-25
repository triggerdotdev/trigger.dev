-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "afterCompleteTaskThreshold" INTEGER NOT NULL DEFAULT 750,
ADD COLUMN     "beforeCompleteTaskThreshold" INTEGER NOT NULL DEFAULT 750,
ADD COLUMN     "beforeExecuteTaskThreshold" INTEGER NOT NULL DEFAULT 1500,
ADD COLUMN     "startTaskThreshold" INTEGER NOT NULL DEFAULT 750;

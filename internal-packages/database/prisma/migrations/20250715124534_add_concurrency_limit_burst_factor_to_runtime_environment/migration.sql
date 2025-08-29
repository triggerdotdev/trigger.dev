-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN     "concurrencyLimitBurstFactor" DECIMAL(4,2) NOT NULL DEFAULT 2.00;

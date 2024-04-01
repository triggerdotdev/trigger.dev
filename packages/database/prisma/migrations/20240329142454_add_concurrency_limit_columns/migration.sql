-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "maximumConcurrencyLimit" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN     "maximumConcurrencyLimit" INTEGER NOT NULL DEFAULT 10;

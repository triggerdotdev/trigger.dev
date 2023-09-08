-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "maximumExecutionTimePerRunInMs" INTEGER NOT NULL DEFAULT 900000;

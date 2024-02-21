-- AlterTable
ALTER TABLE "BackgroundWorker" ADD COLUMN     "cliVersion" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "sdkVersion" TEXT NOT NULL DEFAULT 'unknown';

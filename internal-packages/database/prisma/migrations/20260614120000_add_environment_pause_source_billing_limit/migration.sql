-- CreateEnum
CREATE TYPE "EnvironmentPauseSource" AS ENUM ('BILLING_LIMIT');

-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN "pauseSource" "EnvironmentPauseSource";

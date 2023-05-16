/*
  Warnings:

  - You are about to drop the column `startPosition` on the `JobTrigger` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "JobStartPosition" AS ENUM ('INITIAL', 'LATEST');

-- AlterTable
ALTER TABLE "JobTrigger" DROP COLUMN "startPosition";

-- AlterTable
ALTER TABLE "JobVersion" ADD COLUMN     "startPosition" "JobStartPosition" NOT NULL DEFAULT 'INITIAL';

-- DropEnum
DROP TYPE "JobTriggerStartPosition";

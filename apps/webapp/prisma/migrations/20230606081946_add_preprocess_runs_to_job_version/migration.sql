/*
  Warnings:

  - You are about to drop the column `latest` on the `JobVersion` table. All the data in the column will be lost.
  - You are about to drop the column `prepare` on the `JobVersion` table. All the data in the column will be lost.
  - You are about to drop the column `prepared` on the `JobVersion` table. All the data in the column will be lost.
  - You are about to drop the column `ready` on the `JobVersion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "JobVersion" DROP COLUMN "latest",
DROP COLUMN "prepare",
DROP COLUMN "prepared",
DROP COLUMN "ready",
ADD COLUMN     "preprocessRuns" BOOLEAN NOT NULL DEFAULT false;

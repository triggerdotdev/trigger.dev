/*
  Warnings:

  - You are about to drop the column `maximumScheduleInstancesLimit` on the `Organization` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "maximumScheduleInstancesLimit",
ADD COLUMN     "maximumSchedulesLimit" INTEGER NOT NULL DEFAULT 5;

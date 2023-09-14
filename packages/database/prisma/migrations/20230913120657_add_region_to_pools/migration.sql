/*
  Warnings:

  - Added the required column `region` to the `BackgroundTaskMachinePool` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "BackgroundTaskMachinePool" ADD COLUMN     "region" TEXT NOT NULL;

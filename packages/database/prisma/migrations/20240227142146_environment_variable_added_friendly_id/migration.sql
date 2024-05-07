/*
  Warnings:

  - A unique constraint covering the columns `[friendlyId]` on the table `EnvironmentVariable` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `friendlyId` to the `EnvironmentVariable` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EnvironmentVariable" ADD COLUMN     "friendlyId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariable_friendlyId_key" ON "EnvironmentVariable"("friendlyId");

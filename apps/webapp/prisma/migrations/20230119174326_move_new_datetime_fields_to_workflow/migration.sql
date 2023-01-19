/*
  Warnings:

  - You are about to drop the column `archivedAt` on the `EventRule` table. All the data in the column will be lost.
  - You are about to drop the column `disabledAt` on the `EventRule` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "EventRule" DROP COLUMN "archivedAt",
DROP COLUMN "disabledAt";

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3);

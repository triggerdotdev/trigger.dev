/*
  Warnings:

  - You are about to drop the column `rule` on the `EventRule` table. All the data in the column will be lost.
  - Added the required column `filter` to the `EventRule` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EventRule" DROP COLUMN "rule",
ADD COLUMN     "filter" JSONB NOT NULL;

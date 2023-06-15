/*
  Warnings:

  - You are about to drop the column `alias` on the `JobVersion` table. All the data in the column will be lost.
  - Added the required column `trigger` to the `JobVersion` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobVersion" DROP COLUMN "alias",
ADD COLUMN     "trigger" JSONB NOT NULL;

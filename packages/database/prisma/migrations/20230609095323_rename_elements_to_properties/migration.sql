/*
  Warnings:

  - You are about to drop the column `elements` on the `JobRun` table. All the data in the column will be lost.
  - You are about to drop the column `elements` on the `JobVersion` table. All the data in the column will be lost.
  - You are about to drop the column `elements` on the `Task` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "JobRun" DROP COLUMN "elements",
ADD COLUMN     "properties" JSONB;

-- AlterTable
ALTER TABLE "JobVersion" DROP COLUMN "elements",
ADD COLUMN     "properties" JSONB;

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "elements",
ADD COLUMN     "properties" JSONB;

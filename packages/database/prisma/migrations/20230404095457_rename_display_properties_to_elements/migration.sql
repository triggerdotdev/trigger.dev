/*
  Warnings:

  - You are about to drop the column `displayProperties` on the `Task` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Task" DROP COLUMN "displayProperties",
ADD COLUMN     "elements" JSONB;

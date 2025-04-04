/*
  Warnings:

  - You are about to drop the column `waitpointTags` on the `Waitpoint` table. All the data in the column will be lost.

*/

-- AlterTable
ALTER TABLE "Waitpoint" DROP COLUMN "waitpointTags",
ADD COLUMN     "tags" TEXT[];
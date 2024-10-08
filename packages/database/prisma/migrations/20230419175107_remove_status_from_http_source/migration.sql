/*
  Warnings:

  - You are about to drop the column `status` on the `HttpSource` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "HttpSource" DROP COLUMN "status",
ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT false;

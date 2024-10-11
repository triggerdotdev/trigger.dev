/*
  Warnings:

  - A unique constraint covering the columns `[organizationId,slug]` on the table `APIConnection` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `APIConnection` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "APIConnection" ADD COLUMN     "slug" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "APIConnection_organizationId_slug_key" ON "APIConnection"("organizationId", "slug");

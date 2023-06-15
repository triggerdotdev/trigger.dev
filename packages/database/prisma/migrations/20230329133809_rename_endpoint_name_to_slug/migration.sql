/*
  Warnings:

  - You are about to drop the column `name` on the `Endpoint` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[environmentId,slug]` on the table `Endpoint` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `Endpoint` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Endpoint_environmentId_name_key";

-- AlterTable
ALTER TABLE "Endpoint" DROP COLUMN "name",
ADD COLUMN     "slug" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Endpoint_environmentId_slug_key" ON "Endpoint"("environmentId", "slug");

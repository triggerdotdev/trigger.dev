/*
  Warnings:

  - You are about to drop the column `name` on the `Template` table. All the data in the column will be lost.
  - Added the required column `description` to the `Template` table without a default value. This is not possible if the table is not empty.
  - Added the required column `imageUrl` to the `Template` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shortTitle` to the `Template` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `Template` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Template" DROP COLUMN "name",
ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "imageUrl" TEXT NOT NULL,
ADD COLUMN     "services" TEXT[],
ADD COLUMN     "shortTitle" TEXT NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ADD COLUMN     "workflowIds" TEXT[];

/*
  Warnings:

  - You are about to drop the column `dockerDefinitionUrl` on the `RepositoryProject` table. All the data in the column will be lost.
  - Added the required column `dockerIgnore` to the `RepositoryProject` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dockerfile` to the `RepositoryProject` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RepositoryProject" DROP COLUMN "dockerDefinitionUrl",
ADD COLUMN     "dockerIgnore" TEXT NOT NULL,
ADD COLUMN     "dockerfile" TEXT NOT NULL;

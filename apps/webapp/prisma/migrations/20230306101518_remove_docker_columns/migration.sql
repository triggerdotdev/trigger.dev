/*
  Warnings:

  - You are about to drop the column `dockerIgnore` on the `RepositoryProject` table. All the data in the column will be lost.
  - You are about to drop the column `dockerfile` on the `RepositoryProject` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "RepositoryProject" DROP COLUMN "dockerIgnore",
DROP COLUMN "dockerfile";

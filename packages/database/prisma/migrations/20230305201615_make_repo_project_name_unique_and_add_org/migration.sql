/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `RepositoryProject` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `organizationId` to the `RepositoryProject` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RepositoryProject" ADD COLUMN     "organizationId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryProject_name_key" ON "RepositoryProject"("name");

-- AddForeignKey
ALTER TABLE "RepositoryProject" ADD CONSTRAINT "RepositoryProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

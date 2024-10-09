/*
  Warnings:

  - Added the required column `key` to the `ExternalSource` table without a default value. This is not possible if the table is not empty.
  - Added the required column `organizationId` to the `ExternalSource` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ExternalSource" ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "organizationId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

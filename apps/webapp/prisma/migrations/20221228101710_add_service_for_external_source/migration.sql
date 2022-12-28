/*
  Warnings:

  - Added the required column `service` to the `ExternalSource` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ExternalSource" ADD COLUMN     "service" TEXT;

UPDATE "ExternalSource" SET service = 'github';

-- AlterTable
ALTER TABLE "ExternalSource" ALTER COLUMN "service" SET NOT NULL;


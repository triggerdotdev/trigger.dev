/*
  Warnings:

  - You are about to drop the column `metadataBooleanKeys` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `metadataBooleanValues` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `metadataNumberKeys` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `metadataNumberValues` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `metadataStringKeys` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `metadataStringValues` on the `TaskEvent` table. All the data in the column will be lost.
  - Added the required column `eventData` to the `TaskEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskEvent" DROP COLUMN "metadataBooleanKeys",
DROP COLUMN "metadataBooleanValues",
DROP COLUMN "metadataNumberKeys",
DROP COLUMN "metadataNumberValues",
DROP COLUMN "metadataStringKeys",
DROP COLUMN "metadataStringValues",
ADD COLUMN     "eventData" JSONB NOT NULL;

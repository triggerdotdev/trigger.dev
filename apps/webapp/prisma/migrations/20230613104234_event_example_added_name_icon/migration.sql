/*
  Warnings:

  - Added the required column `name` to the `EventExample` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EventExample" ADD COLUMN     "icon" TEXT,
ADD COLUMN     "name" TEXT NOT NULL;

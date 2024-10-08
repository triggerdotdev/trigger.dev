/*
  Warnings:

  - You are about to drop the column `responseBody` on the `JobRunExecution` table. All the data in the column will be lost.
  - You are about to drop the column `responseHeaders` on the `JobRunExecution` table. All the data in the column will be lost.
  - You are about to drop the column `responseStatus` on the `JobRunExecution` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "JobRunExecution" DROP COLUMN "responseBody",
DROP COLUMN "responseHeaders",
DROP COLUMN "responseStatus";

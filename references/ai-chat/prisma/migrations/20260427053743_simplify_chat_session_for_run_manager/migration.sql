/*
  Warnings:

  - You are about to drop the column `runId` on the `ChatSession` table. All the data in the column will be lost.
  - You are about to drop the column `sessionId` on the `ChatSession` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ChatSession" DROP COLUMN "runId",
DROP COLUMN "sessionId";

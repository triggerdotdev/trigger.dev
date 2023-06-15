/*
  Warnings:

  - You are about to drop the column `params` on the `HttpSource` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "HttpSource" DROP COLUMN "params";

-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "params" JSONB;

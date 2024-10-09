-- CreateEnum
CREATE TYPE "PayloadType" AS ENUM ('JSON', 'REQUEST');

-- AlterTable
ALTER TABLE "EventRecord" ADD COLUMN     "payloadType" "PayloadType" NOT NULL DEFAULT 'JSON';

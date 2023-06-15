-- CreateEnum
CREATE TYPE "CustomEventStatus" AS ENUM ('PENDING', 'PROCESSED');

-- AlterTable
ALTER TABLE "CustomEvent" ADD COLUMN     "status" "CustomEventStatus" NOT NULL DEFAULT 'PENDING';

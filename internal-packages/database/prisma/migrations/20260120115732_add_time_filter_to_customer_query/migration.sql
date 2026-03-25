-- AlterTable
ALTER TABLE "public"."CustomerQuery"
ADD COLUMN "filterFrom" TIMESTAMP(3),
ADD COLUMN "filterPeriod" TEXT,
ADD COLUMN "filterTo" TIMESTAMP(3);
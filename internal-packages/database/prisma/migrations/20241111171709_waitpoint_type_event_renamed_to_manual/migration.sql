/*
  Warnings:

  - The values [EVENT] on the enum `WaitpointType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "WaitpointType_new" AS ENUM ('RUN', 'DATETIME', 'MANUAL');
ALTER TABLE "Waitpoint" ALTER COLUMN "type" TYPE "WaitpointType_new" USING ("type"::text::"WaitpointType_new");
ALTER TYPE "WaitpointType" RENAME TO "WaitpointType_old";
ALTER TYPE "WaitpointType_new" RENAME TO "WaitpointType";
DROP TYPE "WaitpointType_old";
COMMIT;

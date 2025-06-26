/*
  Warnings:

  - The values [CANCEL_THEN_REPLAY] on the enum `BulkActionType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "BulkActionType_new" AS ENUM ('CANCEL', 'REPLAY');
ALTER TABLE "BulkActionGroup" ALTER COLUMN "type" TYPE "BulkActionType_new" USING ("type"::text::"BulkActionType_new");
ALTER TABLE "BulkActionItem" ALTER COLUMN "type" TYPE "BulkActionType_new" USING ("type"::text::"BulkActionType_new");
ALTER TYPE "BulkActionType" RENAME TO "BulkActionType_old";
ALTER TYPE "BulkActionType_new" RENAME TO "BulkActionType";
DROP TYPE "BulkActionType_old";
COMMIT;
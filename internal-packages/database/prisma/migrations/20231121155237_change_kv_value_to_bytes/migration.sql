/*
  Warnings:

  - Changed the type of `value` on the `KeyValueItem` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "KeyValueItem" DROP COLUMN "value",
ADD COLUMN     "value" BYTEA NOT NULL;

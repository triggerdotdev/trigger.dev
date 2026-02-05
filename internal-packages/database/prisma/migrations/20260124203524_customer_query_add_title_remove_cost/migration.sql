-- AlterTable
ALTER TABLE "CustomerQuery"
ADD COLUMN IF NOT EXISTS "title" TEXT;

-- AlterTable
ALTER TABLE "CustomerQuery"
DROP COLUMN IF EXISTS "costInCents";
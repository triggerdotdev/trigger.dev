-- AlterEnum
ALTER TYPE "BulkActionType" ADD VALUE 'CANCEL_THEN_REPLAY';

-- AlterTable
ALTER TABLE "BulkActionGroup"
ADD COLUMN IF NOT EXISTS "cursor" JSONB,
ADD COLUMN IF NOT EXISTS "environmentId" TEXT,
ADD COLUMN IF NOT EXISTS "params" JSONB,
ADD COLUMN IF NOT EXISTS "processedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "queryName" TEXT,
ADD COLUMN IF NOT EXISTS "reason" TEXT,
ADD COLUMN IF NOT EXISTS "totalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- Add foreign key constraints if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'BulkActionGroup_environmentId_fkey'
    ) THEN
        ALTER TABLE "BulkActionGroup" 
        ADD CONSTRAINT "BulkActionGroup_environmentId_fkey" 
        FOREIGN KEY ("environmentId") 
        REFERENCES "RuntimeEnvironment"("id") 
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'BulkActionGroup_userId_fkey'
    ) THEN
        ALTER TABLE "BulkActionGroup" 
        ADD CONSTRAINT "BulkActionGroup_userId_fkey" 
        FOREIGN KEY ("userId") 
        REFERENCES "User"("id") 
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
-- AlterTable
ALTER TABLE "RuntimeEnvironment"
ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "branchName" TEXT,
ADD COLUMN IF NOT EXISTS "git" JSONB,
ADD COLUMN IF NOT EXISTS "parentEnvironmentId" TEXT;

-- AddForeignKey
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.table_constraints 
        WHERE table_name = 'RuntimeEnvironment' 
        AND constraint_name = 'RuntimeEnvironment_parentEnvironmentId_fkey'
    ) THEN 
        ALTER TABLE "RuntimeEnvironment" 
        ADD CONSTRAINT "RuntimeEnvironment_parentEnvironmentId_fkey" 
        FOREIGN KEY ("parentEnvironmentId") 
        REFERENCES "RuntimeEnvironment" ("id") 
        ON DELETE CASCADE 
        ON UPDATE CASCADE;
    END IF;
END $$;
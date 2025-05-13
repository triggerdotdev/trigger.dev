-- AlterTable
ALTER TABLE "RuntimeEnvironment"
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "branchName" TEXT,
ADD COLUMN "git" JSONB;

-- Add the parentEnvironmentId column
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'RuntimeEnvironment' 
        AND column_name = 'parentEnvironmentId'
    ) THEN 
        ALTER TABLE "RuntimeEnvironment" 
        ADD COLUMN "parentEnvironmentId" TEXT;
    END IF;
END $$;

-- AddForeignKey
ALTER TABLE "RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_parentEnvironmentId_fkey" FOREIGN KEY ("parentEnvironmentId") REFERENCES "RuntimeEnvironment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
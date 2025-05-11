-- AlterTable
ALTER TABLE "RuntimeEnvironment"
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "branchName" TEXT,
ADD COLUMN "git" JSONB,
ADD COLUMN "parentEnvironmentId" TEXT;

-- AddForeignKey
ALTER TABLE "RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_parentEnvironmentId_fkey" FOREIGN KEY ("parentEnvironmentId") REFERENCES "RuntimeEnvironment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
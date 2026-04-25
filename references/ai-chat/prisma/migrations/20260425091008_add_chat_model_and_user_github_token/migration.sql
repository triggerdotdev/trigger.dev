-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "githubToken" TEXT;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "eventNames" TEXT[],
ADD COLUMN     "service" TEXT NOT NULL DEFAULT 'trigger';

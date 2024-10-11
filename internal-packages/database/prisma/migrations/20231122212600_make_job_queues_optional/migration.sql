-- DropForeignKey
ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_queueId_fkey";

-- DropForeignKey
ALTER TABLE "JobVersion" DROP CONSTRAINT "JobVersion_queueId_fkey";

-- AlterTable
ALTER TABLE "JobRun" ALTER COLUMN "queueId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "JobVersion" ALTER COLUMN "queueId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "JobQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "JobQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

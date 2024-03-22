-- AlterTable
ALTER TABLE "WorkerDeployment" ADD COLUMN     "triggeredById" TEXT;

-- AddForeignKey
ALTER TABLE "WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

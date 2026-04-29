-- CreateEnum
CREATE TYPE "WorkloadType" AS ENUM ('CONTAINER', 'MICROVM');

-- AlterTable
ALTER TABLE "WorkerInstanceGroup" ADD COLUMN "workloadType" "WorkloadType" NOT NULL DEFAULT 'CONTAINER';

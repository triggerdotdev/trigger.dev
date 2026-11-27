-- Fail fast instead of queueing behind a long txn for the lock the foreign key takes on
-- "WorkerDeployment".
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkerDeploymentMachine" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "imageReference" TEXT NOT NULL,
    "templateKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerDeploymentMachine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkerDeploymentMachine_deploymentId_machineId_key" ON "WorkerDeploymentMachine"("deploymentId", "machineId");

-- AddForeignKey
ALTER TABLE "WorkerDeploymentMachine" DROP CONSTRAINT IF EXISTS "WorkerDeploymentMachine_deploymentId_fkey", ADD CONSTRAINT "WorkerDeploymentMachine_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "WorkerDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

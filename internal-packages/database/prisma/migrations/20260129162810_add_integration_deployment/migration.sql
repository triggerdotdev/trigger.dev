-- CreateTable
CREATE TABLE "public"."IntegrationDeployment" (
    "id" TEXT NOT NULL,
    "integrationName" TEXT NOT NULL,
    "integrationDeploymentId" TEXT NOT NULL,
    "commitSHA" TEXT NOT NULL,
    "deploymentId" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationDeployment_deploymentId_idx" ON "public"."IntegrationDeployment"("deploymentId");

-- CreateIndex
CREATE INDEX "IntegrationDeployment_commitSHA_idx" ON "public"."IntegrationDeployment"("commitSHA");

-- AddForeignKey
ALTER TABLE "public"."IntegrationDeployment" ADD CONSTRAINT "IntegrationDeployment_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "public"."WorkerDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
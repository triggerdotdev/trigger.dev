ALTER TYPE "public"."WorkerDeploymentStatus" ADD VALUE 'INSTALLING';

ALTER TABLE "public"."WorkerDeployment" ADD COLUMN     "installedAt" TIMESTAMP(3);
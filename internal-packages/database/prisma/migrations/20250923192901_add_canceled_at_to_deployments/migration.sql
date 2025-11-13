ALTER TABLE "public"."WorkerDeployment" ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "canceledReason" TEXT;
-- AlterTable
ALTER TABLE "public"."RuntimeEnvironment" ADD COLUMN IF NOT EXISTS "defaultWorkerGroupId" TEXT;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironment" DROP CONSTRAINT IF EXISTS "RuntimeEnvironment_defaultWorkerGroupId_fkey";
ALTER TABLE "public"."RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_defaultWorkerGroupId_fkey" FOREIGN KEY ("defaultWorkerGroupId") REFERENCES "public"."WorkerInstanceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

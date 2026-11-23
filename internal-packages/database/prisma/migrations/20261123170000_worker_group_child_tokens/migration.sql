-- AlterTable
ALTER TABLE "public"."WorkerGroupToken" ADD COLUMN IF NOT EXISTS "workerGroupId" TEXT;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkerGroupToken_workerGroupId_fkey'
  ) THEN
    ALTER TABLE "public"."WorkerGroupToken"
    ADD CONSTRAINT "WorkerGroupToken_workerGroupId_fkey"
    FOREIGN KEY ("workerGroupId") REFERENCES "public"."WorkerInstanceGroup" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

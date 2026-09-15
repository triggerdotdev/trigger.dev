ALTER TABLE "public"."BackgroundWorkerTask"
  ADD COLUMN IF NOT EXISTS "regions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

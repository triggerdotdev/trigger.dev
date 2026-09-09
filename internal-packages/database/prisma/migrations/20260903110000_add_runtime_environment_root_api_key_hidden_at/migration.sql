-- Existing environments remain visible. Application creation paths set this for new environments.
ALTER TABLE "public"."RuntimeEnvironment"
ADD COLUMN IF NOT EXISTS "rootApiKeyHiddenAt" TIMESTAMP(3);

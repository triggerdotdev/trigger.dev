ALTER TABLE "public"."ConnectedGithubRepository" ADD COLUMN IF NOT EXISTS "buildFilters" JSONB;

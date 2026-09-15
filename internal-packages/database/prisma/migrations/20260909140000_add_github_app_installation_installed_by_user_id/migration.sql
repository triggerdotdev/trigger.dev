ALTER TABLE "public"."GithubAppInstallation"
  ADD COLUMN IF NOT EXISTS "installedByUserId" TEXT;

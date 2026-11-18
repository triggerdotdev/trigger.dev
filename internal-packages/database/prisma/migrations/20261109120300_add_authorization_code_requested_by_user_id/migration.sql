ALTER TABLE "public"."AuthorizationCode" ADD COLUMN IF NOT EXISTS "requestedByUserId" TEXT;

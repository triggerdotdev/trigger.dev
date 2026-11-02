ALTER TABLE "public"."AuthorizationCode" ADD COLUMN IF NOT EXISTS "codeChallenge" TEXT;
ALTER TABLE "public"."AuthorizationCode" ADD COLUMN IF NOT EXISTS "callbackPort" INTEGER;
ALTER TABLE "public"."AuthorizationCode" ADD COLUMN IF NOT EXISTS "approvalCodeHash" TEXT;

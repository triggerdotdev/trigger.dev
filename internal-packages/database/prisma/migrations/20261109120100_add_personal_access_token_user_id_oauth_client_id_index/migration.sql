CREATE INDEX CONCURRENTLY IF NOT EXISTS "PersonalAccessToken_oauthClientId_userId_idx" ON "public"."PersonalAccessToken"("oauthClientId", "userId");

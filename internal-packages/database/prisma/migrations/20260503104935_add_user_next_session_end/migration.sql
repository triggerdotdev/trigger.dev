-- AlterTable
-- Nullable column with no default → metadata-only change in PostgreSQL, no
-- row rewrite. Existing users get `nextSessionEnd` populated lazily on
-- their first authenticated request after deploy (see `getUser` in
-- `apps/webapp/app/services/session.server.ts`), or eagerly on next login
-- via `commitAuthenticatedSession`.
ALTER TABLE "public"."User" ADD COLUMN "nextSessionEnd" TIMESTAMP(3);

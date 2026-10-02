-- Shared webhook endpoints: one endpoint row per declared endpoint, with a list of routing targets
-- (each with its own compiled filter) replacing the single target and endpoint-level filter. Hosted
-- webhooks are unreleased, so existing rows are test data and are deleted rather than migrated.

DELETE FROM "public"."WebhookDelivery";
DELETE FROM "public"."WebhookEndpoint";

ALTER TYPE "public"."WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'UNMATCHED';

ALTER TABLE "public"."WebhookEndpoint" DROP COLUMN IF EXISTS "filter",
DROP COLUMN IF EXISTS "filterAst",
DROP COLUMN IF EXISTS "filterAstVersion",
DROP COLUMN IF EXISTS "handlerWebhookId",
DROP COLUMN IF EXISTS "routingTarget",
ADD COLUMN IF NOT EXISTS "declaredId" TEXT NOT NULL,
ADD COLUMN IF NOT EXISTS "routingTargets" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "public"."WebhookDelivery" ADD COLUMN IF NOT EXISTS "targets" JSONB NOT NULL DEFAULT '[]';

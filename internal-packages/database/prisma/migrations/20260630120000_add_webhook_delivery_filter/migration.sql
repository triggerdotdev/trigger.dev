-- Webhook delivery filters: a server-side predicate gates routing (not receipt). A verified delivery
-- that doesn't match becomes a FILTERED row (no run/session) with the reason recorded; the compiled
-- filter AST is stored on the endpoint and evaluated at ingest.

ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'FILTERED';

ALTER TABLE "WebhookDelivery" ADD COLUMN "filterReason" TEXT;

ALTER TABLE "WebhookEndpoint" ADD COLUMN "filter" TEXT;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "filterAst" JSONB;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "filterAstVersion" INTEGER;

-- Add the inbound request headers to webhook deliveries. Surfaced to the webhook task via
-- onEvent({ headers }). Nullable + additive; the ADD COLUMN on the RANGE-partitioned parent
-- cascades to all child partitions automatically.
ALTER TABLE "WebhookDelivery" ADD COLUMN "headers" JSONB;

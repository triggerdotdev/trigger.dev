-- Adds a nullable column to store a queue concurrency-limit override expressed as a percentage
-- of the environment limit. This percentage is the source of truth; the absolute
-- "concurrencyLimit" is materialized from it at save time. Additive and nullable, so existing
-- absolute overrides are unaffected. Decimal(5,2) supports fractional percentages (0.01–100.00).
ALTER TABLE "TaskQueue" ADD COLUMN IF NOT EXISTS "concurrencyLimitOverridePercent" DECIMAL(5,2);

-- AlterEnum
-- Standalone enum-only migration (Q5): the new value is committed before any
-- table migration or code references it, so the wrapped-transaction restriction
-- on using a freshly added enum value never bites.
ALTER TYPE "public"."TaskTriggerSource" ADD VALUE 'WEBHOOK';

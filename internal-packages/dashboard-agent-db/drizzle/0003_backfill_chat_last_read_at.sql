-- 0002's backfill only reaches databases that had not run 0002 yet. Where it already ran,
-- every pre-existing chat kept a NULL `last_read_at` and still reads as unread, so the same
-- statement runs again here. Idempotent: a chat with a value keeps it.
UPDATE "trigger_dashboard_agent"."chats" SET "last_read_at" = coalesce("last_message_at", "created_at") WHERE "last_read_at" IS NULL;

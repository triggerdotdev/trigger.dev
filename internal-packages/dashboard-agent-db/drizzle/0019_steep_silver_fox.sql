CREATE TABLE "trigger_dashboard_agent"."chat_messages" (
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id"),
	CONSTRAINT "chat_messages_chat_position_key" UNIQUE("chat_id","position")
);
--> statement-breakpoint
ALTER TABLE "trigger_dashboard_agent"."chats" ADD COLUMN "next_message_position" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_messages_chat_user_role_idx" ON "trigger_dashboard_agent"."chat_messages" USING btree ("chat_id","message_id") WHERE "trigger_dashboard_agent"."chat_messages"."role" = 'user';--> statement-breakpoint
-- Backfill: every element of `chats.messages` becomes a row, keeping its array order as
-- `position`. A legacy message with no `id` gets one derived from the chat and its
-- ordinal, which is stable across re-runs; two messages sharing an id keep the first,
-- exactly as the old in-memory merge did.
INSERT INTO "trigger_dashboard_agent"."chat_messages" ("chat_id", "message_id", "position", "role", "message", "created_at")
SELECT
	c."id",
	coalesce(nullif(m."value"->>'id', ''), 'legacy:' || c."id" || ':' || m."ordinality"),
	m."ordinality"::integer,
	coalesce(nullif(m."value"->>'role', ''), 'assistant'),
	m."value",
	c."created_at"
FROM "trigger_dashboard_agent"."chats" c
CROSS JOIN LATERAL jsonb_array_elements(coalesce(c."messages", '[]'::jsonb)) WITH ORDINALITY AS m("value", "ordinality")
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The allocator has to start past whatever the backfill wrote, or the next append
-- collides with a backfilled position.
UPDATE "trigger_dashboard_agent"."chats" c
SET "next_message_position" = m."next_position"
FROM (
	SELECT "chat_id", max("position") + 1 AS "next_position"
	FROM "trigger_dashboard_agent"."chat_messages"
	GROUP BY "chat_id"
) m
WHERE m."chat_id" = c."id";
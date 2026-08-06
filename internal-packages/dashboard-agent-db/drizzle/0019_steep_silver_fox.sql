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
CREATE INDEX "chat_messages_chat_user_role_idx" ON "trigger_dashboard_agent"."chat_messages" USING btree ("chat_id","message_id") WHERE "trigger_dashboard_agent"."chat_messages"."role" = 'user';

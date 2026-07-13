CREATE SCHEMA IF NOT EXISTS "trigger_dashboard_agent";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trigger_dashboard_agent"."chat_sessions" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"public_access_token" text NOT NULL,
	"last_event_id" text,
	"run_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trigger_dashboard_agent"."chats" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_org_user_last_msg_idx" ON "trigger_dashboard_agent"."chats" USING btree ("organization_id","user_id","last_message_at" DESC NULLS LAST) WHERE "trigger_dashboard_agent"."chats"."deleted_at" is null;
ALTER TABLE "trigger_dashboard_agent"."chats" ADD COLUMN "transcript_state" jsonb;--> statement-breakpoint
ALTER TABLE "trigger_dashboard_agent"."chats" ADD COLUMN "transcript_cursors" jsonb;
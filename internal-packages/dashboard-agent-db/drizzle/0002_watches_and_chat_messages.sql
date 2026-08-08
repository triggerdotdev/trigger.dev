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
CREATE TABLE "trigger_dashboard_agent"."investigations" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"project_ref" text NOT NULL,
	"environment_ref" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_dashboard_agent"."watch_batches" (
	"environment_id" text NOT NULL,
	"cadence_minutes" integer NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"armed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_tick_at" timestamp with time zone,
	CONSTRAINT "watch_batches_environment_id_cadence_minutes_pk" PRIMARY KEY("environment_id","cadence_minutes")
);
--> statement-breakpoint
CREATE TABLE "trigger_dashboard_agent"."watch_submissions" (
	"chat_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"draft_hash" text NOT NULL,
	"draft" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"watch_id" text,
	"unavailable" boolean DEFAULT false NOT NULL,
	"external_notification_status" text DEFAULT 'not_requested' NOT NULL,
	"external_notification_reason" text,
	"immediate_result" text,
	"refusal_code" text,
	"refusal_error" text,
	"refusal_existing_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_submissions_chat_id_client_request_id_pk" PRIMARY KEY("chat_id","client_request_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_dashboard_agent"."watches" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"identity" text NOT NULL,
	"spec" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"delivery_status" text DEFAULT 'not_required' NOT NULL,
	"cancel_reason" text,
	"resolution" text,
	"observed_outcome" jsonb,
	"investigate_on_attention" boolean DEFAULT false NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_ref" text,
	"environment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"fired_at" timestamp with time zone,
	"delivery_claimed_at" timestamp with time zone,
	"delivery_claim_id" text,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_result" jsonb,
	"tick_count" integer DEFAULT 0 NOT NULL,
	"alert_dispatch_key" text,
	"retention_at" timestamp with time zone GENERATED ALWAYS AS (greatest(delivered_at, cancelled_at, fired_at, last_checked_at, created_at)) STORED,
	"cadence_minutes" integer GENERATED ALWAYS AS (((spec ->> 'checkEveryMinutes')::int)) STORED
);
--> statement-breakpoint
ALTER TABLE "trigger_dashboard_agent"."chats" ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone;
--> statement-breakpoint
-- Chats that predate the column start read, so only activity after this migration lights the dot.
UPDATE "trigger_dashboard_agent"."chats" SET "last_read_at" = coalesce("last_message_at", "created_at") WHERE "last_read_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "trigger_dashboard_agent"."chats" ADD COLUMN IF NOT EXISTS "next_message_position" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE INDEX "chat_messages_chat_user_role_idx" ON "trigger_dashboard_agent"."chat_messages" USING btree ("chat_id","message_id") WHERE "trigger_dashboard_agent"."chat_messages"."role" = 'user';
--> statement-breakpoint
CREATE INDEX "chat_turn_evals_created_idx" ON "trigger_dashboard_agent"."chat_turn_evals" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "investigations_chat_idx" ON "trigger_dashboard_agent"."investigations" USING btree ("chat_id");
--> statement-breakpoint
CREATE INDEX "investigations_open_updated_idx" ON "trigger_dashboard_agent"."investigations" USING btree ("updated_at") WHERE "trigger_dashboard_agent"."investigations"."state"->>'outcome' = 'in_progress';
--> statement-breakpoint
CREATE INDEX "watch_submissions_created_idx" ON "trigger_dashboard_agent"."watch_submissions" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "watches_chat_idx" ON "trigger_dashboard_agent"."watches" USING btree ("chat_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "watches_chat_active_identity_key" ON "trigger_dashboard_agent"."watches" USING btree ("chat_id","project_id","environment_id","identity") WHERE "trigger_dashboard_agent"."watches"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "watches_status_expires_idx" ON "trigger_dashboard_agent"."watches" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "watches_pending_delivery_idx" ON "trigger_dashboard_agent"."watches" USING btree ("fired_at","last_checked_at") WHERE "trigger_dashboard_agent"."watches"."delivery_status" in ('pending', 'delivering');
--> statement-breakpoint
CREATE INDEX "watches_org_user_wake_idx" ON "trigger_dashboard_agent"."watches" USING btree ("organization_id","user_id",coalesce("fired_at", "last_checked_at") desc) WHERE "trigger_dashboard_agent"."watches"."delivery_status" = 'delivered' and "trigger_dashboard_agent"."watches"."status" in ('fired', 'expired');
--> statement-breakpoint
CREATE INDEX "watches_org_user_active_idx" ON "trigger_dashboard_agent"."watches" USING btree ("organization_id","user_id") WHERE "trigger_dashboard_agent"."watches"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "watches_active_env_cadence_idx" ON "trigger_dashboard_agent"."watches" USING btree ("environment_id","cadence_minutes",coalesce("last_attempted_at", "last_checked_at", "created_at"),"expires_at") WHERE "trigger_dashboard_agent"."watches"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "watches_env_cadence_delivery_idx" ON "trigger_dashboard_agent"."watches" USING btree ("environment_id","cadence_minutes","delivery_status",coalesce("fired_at", "last_checked_at")) WHERE "trigger_dashboard_agent"."watches"."status" in ('fired', 'expired') and "trigger_dashboard_agent"."watches"."delivery_status" in ('pending', 'delivering');
--> statement-breakpoint
CREATE INDEX "watches_retention_idx" ON "trigger_dashboard_agent"."watches" USING btree ("retention_at") WHERE "trigger_dashboard_agent"."watches"."status" in ('fired', 'expired', 'cancelled') and "trigger_dashboard_agent"."watches"."delivery_status" in ('not_required', 'delivered');

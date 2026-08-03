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
CREATE TABLE "trigger_dashboard_agent"."watches" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"identity" text NOT NULL,
	"spec" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"delivery_status" text DEFAULT 'not_required' NOT NULL,
	"cancel_reason" text,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"fired_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_result" jsonb,
	"tick_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "investigations_chat_idx" ON "trigger_dashboard_agent"."investigations" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "watches_chat_idx" ON "trigger_dashboard_agent"."watches" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watches_chat_active_identity_key" ON "trigger_dashboard_agent"."watches" USING btree ("chat_id","project_id","environment_id","identity") WHERE "trigger_dashboard_agent"."watches"."status" = 'active';--> statement-breakpoint
CREATE INDEX "watches_status_expires_idx" ON "trigger_dashboard_agent"."watches" USING btree ("status","expires_at");
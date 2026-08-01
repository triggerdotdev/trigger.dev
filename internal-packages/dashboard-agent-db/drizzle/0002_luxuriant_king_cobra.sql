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
CREATE INDEX "investigations_chat_idx" ON "trigger_dashboard_agent"."investigations" USING btree ("chat_id");

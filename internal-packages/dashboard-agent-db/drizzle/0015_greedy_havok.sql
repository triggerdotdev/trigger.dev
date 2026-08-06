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
	"notified_externally" boolean DEFAULT false NOT NULL,
	"immediate_result" text,
	"refusal_code" text,
	"refusal_error" text,
	"refusal_existing_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_submissions_chat_id_client_request_id_pk" PRIMARY KEY("chat_id","client_request_id")
);
--> statement-breakpoint
CREATE INDEX "watch_submissions_created_idx" ON "trigger_dashboard_agent"."watch_submissions" USING btree ("created_at");
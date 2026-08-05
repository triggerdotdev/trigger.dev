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
CREATE INDEX "watches_active_env_idx" ON "trigger_dashboard_agent"."watches" USING btree ("environment_id","expires_at") WHERE "trigger_dashboard_agent"."watches"."status" = 'active';
ALTER TABLE "trigger_dashboard_agent"."watches" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "trigger_dashboard_agent"."watches" ADD COLUMN "observed_outcome" jsonb;
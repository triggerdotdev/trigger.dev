CREATE TABLE "trigger_dashboard_agent"."agent_message_usage" (
	"organization_id" text NOT NULL,
	"period" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_message_usage_organization_id_period_pk" PRIMARY KEY("organization_id","period")
);

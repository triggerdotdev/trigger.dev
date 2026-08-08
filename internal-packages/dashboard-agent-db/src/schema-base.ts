import { pgSchema } from "drizzle-orm/pg-core";

// Tables are schema-qualified explicitly, so the connection needs no `search_path`.
export const dashboardAgentSchema = pgSchema("trigger_dashboard_agent");

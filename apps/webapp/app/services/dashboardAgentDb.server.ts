import { createDashboardAgentDb, type DashboardAgentDb } from "@internal/dashboard-agent-db";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

/**
 * The webapp's connection to the dashboard-agent conversation store (the History
 * tab + the chat panel's create / rename / delete / resume actions). Same Drizzle
 * client the agent task uses, pointed at the same database.
 *
 * This is the agent's OWN datastore — NOT the main Prisma database, which the
 * agent has no access to. Cloud uses the dedicated PlanetScale database; OSS
 * falls back to DATABASE_URL with tables isolated in the `trigger_dashboard_agent`
 * schema.
 */
export const dashboardAgentDb: DashboardAgentDb = singleton("dashboardAgentDb", () => {
  const connectionString = env.DASHBOARD_AGENT_DATABASE_URL ?? env.DATABASE_URL;
  return createDashboardAgentDb(connectionString, {
    max: env.DATABASE_CONNECTION_LIMIT,
  }).db;
});

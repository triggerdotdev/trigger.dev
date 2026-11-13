import { createDashboardAgentDb, type DashboardAgentDbClient } from "@internal/dashboard-agent-db";

/** The url the sweep and retention tasks connect with, so an unwired deployment can skip instead of throw. */
export function agentDbConnectionString(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // `||`, so an empty dedicated url falls back instead of connecting to "".
  return env.DASHBOARD_AGENT_DATABASE_URL || env.DATABASE_URL;
}

// One connection pool per worker process.
let dbClient: DashboardAgentDbClient | undefined;
export function getAgentDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString = agentDbConnectionString();
    if (!connectionString) {
      throw new Error(
        "DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the sweep and retention tasks"
      );
    }
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type DashboardAgentSchema = typeof schema;
export type DashboardAgentDb = PostgresJsDatabase<DashboardAgentSchema>;

export interface DashboardAgentDbClient {
  db: DashboardAgentDb;
  sql: Sql;
  /** Close the underlying connection pool. Call on agent run shutdown. */
  close: () => Promise<void>;
}

export interface CreateDashboardAgentDbOptions {
  /**
   * Max client-side pool size. Keep small — the agent runs in many short-lived
   * task containers and PlanetScale's pooler does the real connection pooling.
   */
  max?: number;
  /** Idle timeout (seconds) so suspended agent runs release connections. */
  idleTimeoutSeconds?: number;
  /** Connection timeout (seconds). */
  connectTimeoutSeconds?: number;
}

/**
 * Create a Drizzle client for the dashboard-agent datastore. Shared by the agent
 * task (its own persistence) and the webapp (History tab + frontend actions).
 *
 * Connections go through a transaction-mode pooler (PlanetScale / PgBouncer-style),
 * so prepared statements are disabled — they don't survive a connection being
 * handed to a different client between checkouts.
 */
// Prisma-style URLs carry `?schema=...`; postgres.js forwards unknown query
// params as server startup config and Postgres rejects `schema`. Our tables are
// schema-qualified, so the param is unnecessary — drop it. Matters for the OSS
// fallback to the main DATABASE_URL.
function normalizeConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete("schema");
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function createDashboardAgentDb(
  connectionString: string,
  options: CreateDashboardAgentDbOptions = {}
): DashboardAgentDbClient {
  const sql = postgres(normalizeConnectionString(connectionString), {
    max: options.max ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: false,
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: () => sql.end(),
  };
}

// Production migration runner for the `trigger_dashboard_agent` schema.
//
// Runs under plain `node migrate.mjs` in the built image: `drizzle-orm` and
// `postgres` are runtime dependencies, so this needs no `drizzle-kit`, `tsx`,
// or build step (keeps the image lean). The OSS container runs this from its
// entrypoint; cloud runs it out-of-band against its own database.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Migrations need a direct (non-pooler) connection; a transaction-mode pooler
// can't run the migrator. Prefer the agent's direct url, then its pooled url,
// then the main DIRECT_URL/DATABASE_URL (OSS single-database fallback; tables
// still land in the `trigger_dashboard_agent` schema).
// `.replace` expands `${VAR}` refs (e.g. the repo .env's DIRECT_URL=${DATABASE_URL});
// node's --env-file loads them literally, unlike Prisma's dotenv-expand.
const connectionString = (
  process.env.DASHBOARD_AGENT_DIRECT_URL ??
  process.env.DASHBOARD_AGENT_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL
)?.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");

if (!connectionString) {
  console.error(
    "[dashboard-agent-db] No database url set (DASHBOARD_AGENT_DIRECT_URL / DASHBOARD_AGENT_DATABASE_URL / DIRECT_URL / DATABASE_URL); cannot migrate."
  );
  process.exit(1);
}

// Prisma-style URLs carry `?schema=...`; postgres.js forwards unknown query
// params as server startup config and Postgres rejects `schema`. Our tables are
// schema-qualified, so the param is unnecessary — drop it.
function normalizeConnectionString(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("schema");
    return url.toString();
  } catch {
    return value;
  }
}

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "drizzle");
const sql = postgres(normalizeConnectionString(connectionString), {
  max: 1,
  prepare: false,
  // Silence the "schema/relation already exists, skipping" notices the journal's
  // idempotent CREATE IF NOT EXISTS emits on every re-run, so restart logs stay clean.
  onnotice: () => {},
});

try {
  // Track our history in a DEDICATED journal table. Drizzle's migrator reads the
  // latest row from <schema>.<table> by created_at and skips any journal entry
  // dated at or before it. The default `drizzle.__drizzle_migrations` is shared
  // by every Drizzle app, so when this DB is shared (OSS single-database fallback
  // and the enterprise-image E2E gate) billing's journal rows poison ours: a
  // billing row dated between our 0000 and 0001 makes the migrator skip 0000 (the
  // CREATE SCHEMA) and run 0001 against a schema that never got created. An own
  // table keeps our history independent (enterprise/db does the same with
  // __enterprise_migrations; billing keeps the default).
  //
  // The table stays in the `drizzle` schema, not our data schema, so 0000's
  // `CREATE SCHEMA "trigger_dashboard_agent"` doesn't collide with the schema the
  // migrator pre-creates for its journal.
  await migrate(drizzle(sql), {
    migrationsFolder,
    migrationsTable: "__dashboard_agent_migrations",
  });
  console.log("[dashboard-agent-db] migrations complete");
} finally {
  await sql.end();
}

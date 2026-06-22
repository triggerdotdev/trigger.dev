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

// Cloud points at the dedicated dashboard-agent database; OSS falls back to the
// main DATABASE_URL (tables still land in the `trigger_dashboard_agent` schema).
const connectionString = process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "[dashboard-agent-db] DASHBOARD_AGENT_DATABASE_URL / DATABASE_URL not set; cannot migrate."
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
  // Journal lives in Drizzle's default `drizzle` schema (matching `drizzle-kit
  // migrate`, so dev and deploy track migrations the same way). It must not be
  // our data schema: the first migration runs `CREATE SCHEMA
  // "trigger_dashboard_agent"`, which would collide with the journal schema the
  // migrator pre-creates. The dashboard agent is the only Drizzle user of its
  // database, so the `drizzle` schema stays exclusively ours.
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("[dashboard-agent-db] migrations complete");
} finally {
  await sql.end();
}

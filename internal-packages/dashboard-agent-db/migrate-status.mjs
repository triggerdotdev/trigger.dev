// Pending-status check for the `trigger_dashboard_agent` schema (sibling of
// migrate.mjs). Exit 0 = up to date, 1 = pending, 2 = error.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__dashboard_agent_migrations";

// Match migrate.mjs: same precedence, and expand `${VAR}` refs (see migrate.mjs).
const connectionString = (
  process.env.DASHBOARD_AGENT_DIRECT_URL ??
  process.env.DASHBOARD_AGENT_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL
)?.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");

if (!connectionString) {
  console.error(
    "[dashboard-agent-db] No database url set (DASHBOARD_AGENT_DIRECT_URL / DASHBOARD_AGENT_DATABASE_URL / DIRECT_URL / DATABASE_URL); cannot check status."
  );
  process.exit(2);
}

// Match migrate.mjs: drop the Prisma-style `?schema=` param postgres.js forwards.
function normalizeConnectionString(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("schema");
    return url.toString();
  } catch {
    return value;
  }
}

const journalPath = join(dirname(fileURLToPath(import.meta.url)), "drizzle/meta/_journal.json");
const sql = postgres(normalizeConnectionString(connectionString), {
  max: 1,
  prepare: false,
  onnotice: () => {},
});

async function main() {
  const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const entries = [...journal.entries].sort((a, b) => a.when - b.when);

  let lastAppliedAt = -1;
  try {
    const rows = await sql`SELECT MAX(created_at)::bigint AS last FROM ${sql(
      MIGRATIONS_SCHEMA
    )}.${sql(MIGRATIONS_TABLE)}`;
    lastAppliedAt = rows[0].last === null ? -1 : Number(rows[0].last);
  } catch (err) {
    // 42P01: journal table absent (fresh database), so nothing is applied.
    if (err.code !== "42P01") throw err;
  }

  const pending = entries.filter((e) => e.when > lastAppliedAt);
  console.log(`${entries.length} migration(s) found, ${entries.length - pending.length} applied`);

  if (pending.length > 0) {
    console.log(`${pending.length} pending migration(s):`);
    for (const e of pending) console.log(`  - ${e.tag}`);
    return 1;
  }

  console.log("Dashboard agent schema is up to date");
  return 0;
}

main()
  .then((code) => sql.end({ timeout: 5 }).then(() => process.exit(code)))
  .catch((err) => {
    console.error(err);
    sql.end({ timeout: 5 }).finally(() => process.exit(2));
  });

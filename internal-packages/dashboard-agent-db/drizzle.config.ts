import { defineConfig } from "drizzle-kit";

// Migrations need a direct (non-pooler) connection; a transaction-mode pooler
// can't run the migrator. Prefer the agent's direct url, then its pooled url,
// then the main DIRECT_URL/DATABASE_URL (OSS single-database fallback; tables
// still land in the trigger_dashboard_agent schema).
const url =
  process.env.DASHBOARD_AGENT_DIRECT_URL ??
  process.env.DASHBOARD_AGENT_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "postgres://placeholder"; // generate is offline; a real url is only needed for migrate/studio

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Only manage our schema — never introspect or diff Prisma's `public` schema.
  schemaFilter: ["trigger_dashboard_agent"],
  // Own journal table so dev (`drizzle-kit migrate`) and deploy (migrate.mjs)
  // share one history and we don't cross-poison the default
  // drizzle.__drizzle_migrations when the DB is shared. See migrate.mjs.
  migrations: { table: "__dashboard_agent_migrations", schema: "drizzle" },
  dbCredentials: { url },
});

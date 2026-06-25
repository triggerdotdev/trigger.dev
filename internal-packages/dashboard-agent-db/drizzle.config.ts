import { defineConfig } from "drizzle-kit";

// Cloud points at the dedicated PlanetScale database; OSS falls back to the main
// DATABASE_URL (tables still land in the trigger_dashboard_agent schema).
const url =
  process.env.DASHBOARD_AGENT_DATABASE_URL ??
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

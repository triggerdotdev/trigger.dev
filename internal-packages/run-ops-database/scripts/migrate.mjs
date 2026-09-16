// Run Prisma migrations against the dedicated NEW run-ops database (the second physical DB in the
// split). It owns its own migration history, so it is migrated independently of the control-plane
// DB. Connects via RUN_OPS_DATABASE_URL — the same var the webapp uses — so migrations always
// target the DB the app connects to.
//
// Usage: node scripts/migrate.mjs [deploy|status]   (defaults to deploy)
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expand = (value) => value?.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");

const subcommand = process.argv[2] === "status" ? "status" : "deploy";

const databaseUrl = expand(process.env.RUN_OPS_DATABASE_URL);

if (!databaseUrl) {
  // Single-DB installs never set it — safe no-op. A genuinely-expected DB is gated on by the caller.
  console.log(
    `run-ops migrate ${subcommand}: RUN_OPS_DATABASE_URL is not set. ` +
      "No dedicated run-ops database configured — skipping."
  );
  process.exit(0);
}

console.log(`Running \`prisma migrate ${subcommand}\` against the configured run-ops database`);

const result = spawnSync("prisma", ["migrate", subcommand, "--schema", "prisma/schema.prisma"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    RUN_OPS_DATABASE_URL: databaseUrl,
  },
});

process.exit(result.status ?? 1);

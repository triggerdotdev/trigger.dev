// Run Prisma migrations against the dedicated NEW run-ops database (the second physical DB in the
// split). It owns its own migration history, so it is migrated independently of the control-plane
// DB. Connects via RUN_OPS_DATABASE_URL — the same var the webapp uses — so migrations always
// target the DB the app connects to.
//
// Usage: node scripts/migrate.mjs [deploy|status]   (defaults to deploy)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Read from local .env files so dev works without an exported env; deploy environments inject vars directly.
function readFromEnvFiles(key) {
  for (const file of [resolve(packageRoot, ".env"), resolve(packageRoot, "../../.env")]) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] !== key) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  }
  return undefined;
}

// Expand `${VAR}` refs in env-file values (our manual reader loads them literally, unlike Prisma's
// dotenv-expand), so a `.env` like RUN_OPS_DATABASE_URL=${DATABASE_URL} still resolves.
const expand = (value) =>
  value?.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? readFromEnvFiles(k) ?? "");
const resolveVar = (key) => expand(process.env[key] || readFromEnvFiles(key));
const redact = (url) => url.replace(/:\/\/[^@]*@/, "://***@");

const subcommand = process.argv[2] === "status" ? "status" : "deploy";

const databaseUrl = resolveVar("RUN_OPS_DATABASE_URL");

if (!databaseUrl) {
  // Single-DB installs never set it — safe no-op. A genuinely-expected DB is gated on by the caller.
  console.log(
    `run-ops migrate ${subcommand}: RUN_OPS_DATABASE_URL is not set (checked env and .env). ` +
      "No dedicated run-ops database configured — skipping."
  );
  process.exit(0);
}

console.log(
  `Running \`prisma migrate ${subcommand}\` against the run-ops database (${redact(databaseUrl)})`
);

const result = spawnSync("prisma", ["migrate", subcommand, "--schema", "prisma/schema.prisma"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    RUN_OPS_DATABASE_URL: databaseUrl,
  },
});

process.exit(result.status ?? 1);

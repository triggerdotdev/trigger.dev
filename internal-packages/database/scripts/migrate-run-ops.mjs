// Apply Prisma migrations to the RUN-OPS database — the second physical DB in the run-ops
// split. The standard `db:migrate` only targets DATABASE_URL (the control-plane DB), so the
// run-ops DB must be migrated explicitly or its schema drifts (e.g. cross-DB FKs that were
// dropped on the control-plane DB linger on the run-ops DB and break inserts).
//
// The run-ops connection comes from TASK_RUN_DATABASE_URL / TASK_RUN_DATABASE_DIRECT_URL
// (set directly in deploy environments; read from the local .env otherwise). We then run
// `prisma migrate deploy` with DATABASE_URL/DIRECT_URL pointed at it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dbPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readFromEnvFiles(key) {
  for (const file of [resolve(dbPackageRoot, ".env"), resolve(dbPackageRoot, "../../.env")]) {
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

const resolveVar = (key) => process.env[key] || readFromEnvFiles(key);
const redact = (url) => url.replace(/:\/\/[^@]*@/, "://***@");

const databaseUrl = resolveVar("TASK_RUN_DATABASE_URL");
const directUrl = resolveVar("TASK_RUN_DATABASE_DIRECT_URL") || databaseUrl;

if (!databaseUrl) {
  console.error(
    "db:migrate:run-ops: TASK_RUN_DATABASE_URL is not set (checked env and .env). " +
      "It is the run-ops database in the split — nothing to migrate without it."
  );
  process.exit(1);
}

console.log(`Applying Prisma migrations to the run-ops database (${redact(databaseUrl)})`);

const result = spawnSync("prisma", ["migrate", "deploy"], {
  cwd: dbPackageRoot,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl },
});

process.exit(result.status ?? 1);

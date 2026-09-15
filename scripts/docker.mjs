#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSyncVarlock } from "varlock/exec-sync-varlock";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const appEnv = args[0] === "--app-env";
if (appEnv) args.shift();

const composeFilter =
  "COMPOSE_*,CONTAINER_PREFIX,*_HOST_PORT,DB_*VOLUME,REPLICA_APPLY_DELAY,GOOSE_COMMAND";

let resolved;
try {
  resolved = JSON.parse(
    execSyncVarlock(`load --format json --compact${appEnv ? "" : ` --filter ${composeFilter}`}`, {
      cwd: appEnv ? resolve(repoRoot, "apps/webapp") : repoRoot,
      exitOnError: false,
      showLogsOnError: false,
    })
  );
} catch {
  const checkCommand = appEnv ? "pnpm --filter webapp run env:check" : "pnpm run env:check";
  console.error(`Unable to load local configuration. Run ${checkCommand} for validation errors.`);
  process.exit(1);
}

const env = Object.fromEntries(
  Object.entries(resolved)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => [key, String(value)])
);

// Compose interpolates YAML values, including secrets containing dollar signs.
const composeEnv = Object.fromEntries(
  Object.entries(env).map(([key, value]) => [key, value.replaceAll("$", () => "$$")])
);

try {
  execFileSync(
    "docker",
    [
      "compose",
      ...(appEnv ? ["--project-directory", resolve(repoRoot, "docker"), "-f", "-"] : []),
      ...args,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env, COMPOSE_DISABLE_ENV_FILE: "true" },
      // The real Compose file merges last, preserving its container-specific URLs.
      input: appEnv
        ? JSON.stringify({ services: { app: { environment: composeEnv } } })
        : undefined,
      stdio: appEnv ? ["pipe", "inherit", "inherit"] : "inherit",
    }
  );
} catch (err) {
  process.exit(err.status ?? 1);
}

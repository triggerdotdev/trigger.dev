#!/usr/bin/env node
// Cross-platform wrapper for `docker compose` that conditionally passes
// `--env-file <repo-root>/.env` when the file exists. Replaces an earlier
// inline `$([ -f .env ] && echo --env-file .env)` shell substitution that
// only worked in POSIX shells, breaking native Windows `cmd.exe` runs.
//
// Used by the root `pnpm run docker` / `docker:full` scripts and by the
// clickhouse package's `db:migrate` script. Always runs compose with cwd
// set to the repo root, so callers can pass `-f docker/docker-compose.yml`
// from anywhere in the workspace.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(repoRoot, ".env");
const envArgs = existsSync(envPath) ? ["--env-file", envPath] : [];

try {
  execFileSync("docker", ["compose", ...envArgs, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: repoRoot,
  });
} catch (err) {
  process.exit(err.status ?? 1);
}

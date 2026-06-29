// Load the monorepo root .env (the package's .env is a symlink to it) so the
// real-model evals pick up ANTHROPIC_API_KEY without the caller exporting it.
// Runs as a vitest setupFile before the eval modules are imported, so the
// `ANTHROPIC_API_KEY` gate in dashboard-agent.eval.ts sees the loaded value.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, ".env"), // package symlink to the root .env
  resolve(here, "../../.env"), // monorepo root
  resolve(process.cwd(), ".env"),
];

for (const path of candidates) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  break;
}

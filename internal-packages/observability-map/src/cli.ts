import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanDirectory } from "./scan.js";
import { buildReport, scoreEntry } from "./score.js";
import { renderTerminal } from "./report/terminal.js";
import { renderJson } from "./report/json.js";

const DEFAULT_ROUTES = "apps/webapp/app/routes";

/**
 * Walks up from this file looking for `pnpm-workspace.yaml`, so the routes directory resolves
 * correctly whether `map` is run from the repo root or from the package directory (where
 * `pnpm --filter` puts you). Resolving `DEFAULT_ROUTES` against `process.cwd()` instead would only
 * work from the repo root.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find repo root (no pnpm-workspace.yaml in any parent directory)");
}

export function main(argv: string[]): number {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const noWrite = args.includes("--no-write");
  const target = args.find((a) => !a.startsWith("--"));

  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const routesDir = resolve(repoRoot, DEFAULT_ROUTES);
  const { entryPoints, parseFailures } = scanDirectory(routesDir);

  if (target) {
    const match = entryPoints.find(
      (e) => e.fileName === target || e.fileName.startsWith(target.replace(/^\//, ""))
    );
    if (!match) {
      process.stderr.write(`no entry point matching "${target}"\n`);
      return 1;
    }
    const scored = scoreEntry(match);
    const measuredNote = scored.measured ? "" : "  (not measured: no applicable checks)";
    process.stdout.write(
      `${scored.routePath}  ${scored.score}/100${measuredNote}\n${scored.fileName}\n\nCHECKS\n`
    );
    for (const c of scored.checks) {
      const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "n/a ";
      process.stdout.write(`  ${mark}  ${c.id}${c.detail ? `  (${c.detail})` : ""}\n`);
    }
    return 0;
  }

  const report = buildReport(entryPoints, parseFailures);
  process.stdout.write(asJson ? renderJson(report) : renderTerminal(report));
  process.stdout.write("\n");
  if (!noWrite) {
    writeFileSync(resolve(repoRoot, "observability-map.json"), renderJson(report));
  }
  return 0;
}

process.exitCode = main(process.argv);

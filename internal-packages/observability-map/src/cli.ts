import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanDirectory } from "./scan.js";
import { buildReport, scoreEntry } from "./score.js";
import { routePathOf } from "./adapters/remix.js";
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

/** Where output goes. Injectable so the tests can read it without spawning a process. */
export type Io = { out: (s: string) => void; err: (s: string) => void };

const processIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * Entry points matching what the user typed, by file name or by route path, exact first.
 *
 * Route paths matter because they are what the report prints: `map /api/v1/token` used to exit 1
 * because only the file name was matched, so the identifier on screen was not one you could paste
 * back in.
 */
function findMatches(entryPoints: { fileName: string }[], target: string) {
  const asPath = target.startsWith("/") ? target : `/${target}`;
  const asFile = target.replace(/^\//, "");

  const exact = entryPoints.filter(
    (e) => e.fileName === target || routePathOf(e.fileName) === asPath
  );
  if (exact.length > 0) return exact;

  return entryPoints.filter(
    (e) => e.fileName.startsWith(asFile) || routePathOf(e.fileName).startsWith(asPath)
  );
}

export function main(argv: string[], io: Io = processIo): number {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const noWrite = args.includes("--no-write");
  const target = args.find((a) => !a.startsWith("--"));

  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const routesDir = resolve(repoRoot, DEFAULT_ROUTES);
  const { entryPoints, parseFailures } = scanDirectory(routesDir);

  if (target) {
    const matches = findMatches(entryPoints, target);
    if (matches.length === 0) {
      io.err(`no entry point matching "${target}"\n`);
      return 1;
    }
    if (matches.length > 1) {
      const others = matches.slice(1, 4).map((m) => routePathOf(m.fileName));
      const rest = matches.length - 1 - others.length;
      io.err(
        `"${target}" matches ${matches.length} entry points, showing the first. ` +
          `Others: ${others.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}\n`
      );
    }
    const scored = scoreEntry(matches[0]!);
    const measuredNote = scored.measured ? "" : "  (not measured: no applicable checks)";
    io.out(
      `${scored.routePath}  ${scored.score}/100${measuredNote}\n${scored.fileName}\n\nCHECKS\n`
    );
    for (const c of scored.checks) {
      const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "n/a ";
      io.out(`  ${mark}  ${c.id}${c.detail ? `  (${c.detail})` : ""}\n`);
    }
    return 0;
  }

  const report = buildReport(entryPoints, parseFailures);
  io.out(asJson ? renderJson(report) : renderTerminal(report));
  io.out("\n");
  if (!noWrite) {
    writeFileSync(resolve(repoRoot, "observability-map.json"), renderJson(report));
  }
  return 0;
}

// Only when run as a program. Importing the module, which the tests do, must not scan the tree or
// write a report.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv);

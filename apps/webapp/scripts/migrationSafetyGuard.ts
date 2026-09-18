/**
 * Postgres migration safety guard. Checks every Prisma migration at or after a cutoff
 * timestamp for idempotent, lock-safe DDL and exits non-zero on any violation. The rules live
 * in `migrationSafetyGuard.core.ts`.
 *
 * The cutoff is not defaulted here; the `guard:migrations` script in package.json pins it, so
 * that is where the enforced date lives. Migrations before it were already applied and are left
 * alone. The last `--cutoff` wins and `--all` overrides it, so:
 *
 *   pnpm --filter webapp run guard:migrations                        # CI gate, pinned cutoff
 *   pnpm --filter webapp run guard:migrations -- --all               # audit the whole history
 *   pnpm --filter webapp run guard:migrations -- --cutoff 20260101   # audit from a date
 *   pnpm --filter webapp run guard:migrations -- path/to/migration.sql ...
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { checkMigration, type Violation } from "./migrationSafetyGuard.core";
import { findRepoRoot } from "./lib/repoRoot";

const REPO_ROOT = findRepoRoot(process.cwd());

const MIGRATION_DIRS = [
  path.join(REPO_ROOT, "internal-packages", "database", "prisma", "migrations"),
  path.join(REPO_ROOT, "internal-packages", "run-ops-database", "prisma", "migrations"),
];

type Args = { cutoff: string | null; all: boolean; files: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { cutoff: null, all: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--all") args.all = true;
    else if (a === "--cutoff") {
      const v = argv[++i];
      if (!v || !/^\d{8}(\d{6})?$/.test(v)) {
        console.error("--cutoff expects YYYYMMDD or YYYYMMDDHHMMSS");
        process.exit(2);
      }
      args.cutoff = v;
    } else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else args.files.push(a);
  }
  if (!args.all && args.cutoff === null && args.files.length === 0) {
    console.error("pass --cutoff YYYYMMDD, --all, or explicit migration.sql paths");
    process.exit(2);
  }
  return args;
}

function collectMigrationFiles(cutoff: string | null, all: boolean): string[] {
  const cutoffKey = (cutoff ?? "").padEnd(14, "0");
  const files: string[] = [];
  for (const dir of MIGRATION_DIRS) {
    if (!fs.existsSync(dir)) {
      console.error(`migrations directory not found: ${dir}`);
      process.exit(2);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = /^(\d{14})_/.exec(entry.name);
      if (!m) continue;
      if (!all && m[1] < cutoffKey) continue;
      const file = path.join(dir, entry.name, "migration.sql");
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files.sort();
}

function printViolations(file: string, violations: Violation[]) {
  const rel = path.relative(REPO_ROOT, file);
  for (const v of violations) {
    console.error(`\n${rel}:${v.line}  [${v.rule}] ${v.message}`);
    console.error(`    ${v.statement}`);
    console.error(`    fix: ${v.hint}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const invokedFrom = process.env.INIT_CWD ?? process.cwd();
  const files =
    args.files.length > 0
      ? args.files.map((f) => path.resolve(invokedFrom, f))
      : collectMigrationFiles(args.cutoff, args.all);

  let failures = 0;
  let suppressed = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`file not found: ${file}`);
      process.exit(2);
    }
    const result = checkMigration(fs.readFileSync(file, "utf8"));
    suppressed += result.suppressed;
    if (result.violations.length > 0) {
      failures += result.violations.length;
      printViolations(file, result.violations);
    }
  }

  const scope = args.files.length > 0 ? "given" : args.all ? "all" : `cutoff ${args.cutoff}`;
  if (failures === 0) {
    console.log(
      `migration guard: OK (${files.length} migration(s) checked, ${scope}` +
        (suppressed > 0 ? `, ${suppressed} allowed by directive` : "") +
        ")."
    );
    return;
  }

  console.error(
    `\nmigration guard: ${failures} violation(s) in ${files.length} migration(s) checked (${scope}).\n` +
      `Every statement must be safe to re-run after a partial apply, and indexes on existing tables ` +
      `must be built CONCURRENTLY in a file of their own. See .claude/rules/database-safety.md.\n` +
      `A statement that genuinely cannot follow the rules can carry a\n` +
      `  -- migration-guard: allow <reason>\n` +
      `comment on the line above it.\n`
  );
  process.exit(1);
}

main();

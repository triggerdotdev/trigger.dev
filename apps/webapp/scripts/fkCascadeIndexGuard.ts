/**
 * FK-cascade index guard — a schema-aware fence against the class of bug fixed in
 * #4554, #4555, #4588: a relation with `onDelete: Cascade | SetNull` whose child FK column
 * has no index, so every parent delete fires a cascade that sequentially scans the whole
 * child table.
 *
 * Rule: for every relation field carrying `onDelete: Cascade | SetNull` (which always sits on
 * the child side, alongside `fields: [...]`), the FIRST FK scalar must be the LEADING column
 * of some index on that model (`@@index`, `@@unique`, `@@id`, or a field-level `@id`/`@unique`).
 * A leading FK column lets the cascade's `WHERE fk = $1` use the index instead of a seq scan.
 *
 * Not every unindexed cascade FK is a live bug: when the parent is only ever SOFT-deleted, the
 * cascade never fires, so the missing index is harmless. The guard CANNOT tell hard- from
 * soft-delete — that lives in application code (`parent.delete()` vs `parent.update({ deletedAt })`),
 * not in the schema, and a `deletedAt` column proves neither direction. So the guard makes no
 * such judgment: it flags every unindexed cascade FK uniformly and — exactly like
 * runOpsLegacyGuard — carries a BASELINE of the currently accepted ones. Only violations NOT in
 * the baseline fail `--check`. The point is the forcing function: a new cascade FK stops CI and
 * makes a human answer "is the parent ever hard-deleted?" — add the index if yes, regenerate the
 * baseline with a reason if no.
 *
 * Modes (mirrors guard:runops-legacy):
 *   tsx ./scripts/fkCascadeIndexGuard.ts             # regenerate the baseline
 *   tsx ./scripts/fkCascadeIndexGuard.ts --check      # CI gate: exit 1 on any un-baselined violation
 */
import * as fs from "node:fs";
import * as path from "node:path";

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());

const SCHEMAS = [
  {
    label: "control-plane",
    file: path.join(REPO_ROOT, "internal-packages", "database", "prisma", "schema.prisma"),
  },
  {
    label: "run-ops",
    file: path.join(REPO_ROOT, "internal-packages", "run-ops-database", "prisma", "schema.prisma"),
  },
];

const BASELINE_PATH = path.join(
  REPO_ROOT,
  "apps",
  "webapp",
  "scripts",
  "fk-cascade-index-baseline.json"
);

type Violation = {
  key: string;
  schema: string;
  model: string;
  relationField: string;
  fkColumns: string[];
  onDelete: string;
};

function leadingColumn(bracketBody: string): string | null {
  const first = bracketBody.split(",")[0]?.trim();
  if (!first) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(first);
  return m ? m[1] : null;
}

function allColumns(bracketBody: string): string[] {
  return bracketBody
    .split(",")
    .map((c) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(c)?.[1])
    .filter((c): c is string => Boolean(c));
}

function scanSchema(label: string, file: string): Violation[] {
  const text = fs.readFileSync(file, "utf8");
  const violations: Violation[] = [];

  const modelRe = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm;
  let mm: RegExpExecArray | null;
  while ((mm = modelRe.exec(text))) {
    const model = mm[1];
    const body = mm[2];
    const lines = body.split("\n");

    const leadingIndexed = new Set<string>();
    for (const raw of lines) {
      const line = raw.trim();
      const block = /^@@(index|unique|id)\(\s*\[([^\]]*)\]/.exec(line);
      if (block) {
        const lead = leadingColumn(block[2]);
        if (lead) leadingIndexed.add(lead);
        continue;
      }
      const fieldDecl = /^([A-Za-z_][A-Za-z0-9_]*)\s+\S+.*@(id|unique)\b/.exec(line);
      if (fieldDecl && !line.startsWith("@@")) {
        leadingIndexed.add(fieldDecl[1]);
      }
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.includes("@relation(")) continue;
      const onDelete = /onDelete:\s*(Cascade|SetNull)/.exec(line);
      if (!onDelete) continue;
      const fields = /fields:\s*\[([^\]]*)\]/.exec(line);
      if (!fields) continue;
      const fkColumns = allColumns(fields[1]);
      const lead = fkColumns[0];
      if (!lead) continue;
      const relationField = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1] ?? "?";

      if (!leadingIndexed.has(lead)) {
        violations.push({
          key: `${label}:${model}.${relationField}`,
          schema: label,
          model,
          relationField,
          fkColumns,
          onDelete: onDelete[1],
        });
      }
    }
  }
  return violations;
}

function main() {
  const check = process.argv.includes("--check");

  const all: Violation[] = [];
  for (const s of SCHEMAS) {
    if (!fs.existsSync(s.file)) {
      console.error(`schema not found: ${s.file}`);
      process.exit(2);
    }
    all.push(...scanSchema(s.label, s.file));
  }
  all.sort((a, b) => a.key.localeCompare(b.key));

  if (!check) {
    const baseline = {
      _comment:
        "Accepted unindexed cascade/SetNull FK columns. Each is either a soft-deleted parent " +
        "(cascade never fires) or an accepted risk. Adding a NEW relation here should be a " +
        "deliberate choice with a reason in the PR. Prefer adding the index instead.",
      violations: all.map((v) => ({
        key: v.key,
        onDelete: v.onDelete,
        fkColumns: v.fkColumns,
      })),
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`Wrote baseline with ${all.length} accepted unindexed cascade FK(s).`);
    console.log(`  -> ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`baseline missing: ${BASELINE_PATH}. Run without --check to generate it.`);
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as {
    violations: { key: string }[];
  };
  const baselined = new Set(baseline.violations.map((v) => v.key));
  const fresh = all.filter((v) => !baselined.has(v.key));

  if (fresh.length === 0) {
    console.log(`fk-cascade-index guard: OK (${all.length} baselined, 0 new).`);
    return;
  }

  console.error(
    `\nfk-cascade-index guard: ${fresh.length} new unindexed cascade FK column(s).\n` +
      `Each fires a full sequential scan of the child table on every parent delete.\n`
  );
  for (const v of fresh) {
    console.error(
      `  ${v.schema}: ${v.model}.${v.relationField}  ` +
        `(onDelete: ${v.onDelete}, fk: [${v.fkColumns.join(", ")}])`
    );
  }
  console.error(
    `\nFix: add @@index([${fresh[0].fkColumns[0]}]) (or a composite leading with it) to the ` +
      `child model, in its own migration with CREATE INDEX CONCURRENTLY IF NOT EXISTS.\n` +
      `If the parent is only ever soft-deleted (cascade never fires), regenerate the baseline ` +
      `and explain why in the PR.\n`
  );
  process.exit(1);
}

main();

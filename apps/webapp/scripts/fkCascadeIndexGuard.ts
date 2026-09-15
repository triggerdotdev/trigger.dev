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
 * A baseline entry is matched on its key AND its onDelete action AND its ordered fkColumns, so
 * changing a relation's FK column or flipping Cascade/SetNull re-triggers the guard rather than
 * silently inheriting the old acceptance. `--check` also fails on STALE baseline entries whose
 * fingerprint no longer appears in the schema (the FK got indexed or removed), so the baseline
 * can't rot: a fixed entry must be pruned by regenerating, otherwise a later change that removes
 * the index would be silently re-accepted by the leftover entry.
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

function fingerprint(key: string, onDelete: string, fkColumns: string[]): string {
  return `${key}::${onDelete}::${fkColumns.join(",")}`;
}

function scrubLine(line: string): { code: string; masked: string } {
  let code = "";
  let masked = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      code += ch;
      masked += " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      code += ch;
      masked += " ";
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    code += ch;
    masked += ch;
  }
  return { code, masked };
}

function toLogicalLines(body: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const raw of body.split("\n")) {
    const { code, masked } = scrubLine(raw);
    const trimmed = code.trim();
    if (trimmed === "") continue;
    buf = buf === "" ? trimmed : `${buf} ${trimmed}`;
    for (const ch of masked) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf !== "") out.push(buf);
  return out;
}

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
    const lines = toLogicalLines(mm[2]);

    const leadingIndexed = new Set<string>();
    for (const line of lines) {
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

    for (const line of lines) {
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

function serializeBaseline(comment: string, violations: Violation[]): string {
  const lines: string[] = ["{", `  "_comment": ${JSON.stringify(comment)},`, `  "violations": [`];
  violations.forEach((v, i) => {
    const trailer = i < violations.length - 1 ? "," : "";
    lines.push(
      "    {",
      `      "key": ${JSON.stringify(v.key)},`,
      `      "onDelete": ${JSON.stringify(v.onDelete)},`,
      `      "fkColumns": ${JSON.stringify(v.fkColumns)}`,
      `    }${trailer}`
    );
  });
  lines.push("  ]", "}");
  return lines.join("\n") + "\n";
}

type BaselineEntry = { key: string; onDelete: string; fkColumns: string[] };

function loadBaseline(): BaselineEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`baseline is not valid JSON: ${BASELINE_PATH}. Regenerate it without --check.`);
    process.exit(2);
  }
  const violations = (parsed as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) {
    console.error(`baseline is missing a "violations" array: ${BASELINE_PATH}.`);
    process.exit(2);
  }
  const entries: BaselineEntry[] = [];
  for (const v of violations) {
    const entry = v as { key?: unknown; onDelete?: unknown; fkColumns?: unknown };
    if (
      typeof entry.key !== "string" ||
      (entry.onDelete !== "Cascade" && entry.onDelete !== "SetNull") ||
      !Array.isArray(entry.fkColumns) ||
      entry.fkColumns.length === 0 ||
      !entry.fkColumns.every((c) => typeof c === "string")
    ) {
      console.error(`baseline has a malformed entry: ${JSON.stringify(v)}`);
      process.exit(2);
    }
    entries.push({
      key: entry.key,
      onDelete: entry.onDelete,
      fkColumns: entry.fkColumns as string[],
    });
  }
  return entries;
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
    const comment =
      "Accepted unindexed cascade/SetNull FK columns. Each is either a soft-deleted parent " +
      "(cascade never fires) or an accepted risk. Adding a NEW relation here should be a " +
      "deliberate choice with a reason in the PR. Prefer adding the index instead.";
    fs.writeFileSync(BASELINE_PATH, serializeBaseline(comment, all));
    console.log(`Wrote baseline with ${all.length} accepted unindexed cascade FK(s).`);
    console.log(`  -> ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`baseline missing: ${BASELINE_PATH}. Run without --check to generate it.`);
    process.exit(2);
  }
  const baselineEntries = loadBaseline();
  const baselinedFps = new Set(
    baselineEntries.map((e) => fingerprint(e.key, e.onDelete, e.fkColumns))
  );
  const currentFps = new Set(all.map((v) => fingerprint(v.key, v.onDelete, v.fkColumns)));

  const fresh = all.filter((v) => !baselinedFps.has(fingerprint(v.key, v.onDelete, v.fkColumns)));
  const stale = baselineEntries.filter(
    (e) => !currentFps.has(fingerprint(e.key, e.onDelete, e.fkColumns))
  );

  if (fresh.length === 0 && stale.length === 0) {
    console.log(`fk-cascade-index guard: OK (${baselinedFps.size} baselined, 0 new, 0 stale).`);
    return;
  }

  if (fresh.length > 0) {
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
  }

  if (stale.length > 0) {
    console.error(
      `\nfk-cascade-index guard: ${stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"} ` +
        `no longer present in the schema (now indexed or removed):\n`
    );
    for (const e of stale) {
      console.error(`  ${e.key}  (onDelete: ${e.onDelete}, fk: [${e.fkColumns.join(", ")}])`);
    }
    console.error(
      `\nRegenerate the baseline so a later change can't silently re-accept these:\n` +
        `  pnpm --filter webapp run guard:fk-cascade-index\n`
    );
  }

  process.exit(1);
}

main();

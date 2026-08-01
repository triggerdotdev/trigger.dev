import type { MapReport, ScoredEntry } from "../score.js";
import { auditLine, contextLine, contextOnly, scoredFailures } from "./terminal.js";

/** First line of every comment this job posts, so the upsert step can find its own comment again. */
export const MARKER = "<!-- observability-map-report -->";

const MAX_CHANGED_ROWS = 15;

const failingIds = (e: ScoredEntry) => e.checks.filter((c) => c.status === "fail").map((c) => c.id);

function scoreLine(head: MapReport, base: MapReport | null): string {
  const headline =
    head.global === null
      ? `not measured over ${head.measured} measured of ${head.entries.length} entry points`
      : `**${head.global}/100** over ${head.measured} measured of ${head.entries.length} entry points`;

  if (!base) return headline;
  if (base.global === null || head.global === null) return `${headline} (base not measured)`;

  const diff = head.global - base.global;
  const comparison =
    diff === 0
      ? `(base ${base.global}, no change)`
      : diff > 0
        ? `(base ${base.global}, up ${diff})`
        : `(base ${base.global}, down ${-diff})`;
  return `${headline} ${comparison}`;
}

type ChangedRow = {
  routePath: string;
  sensitive: boolean;
  baseScore: number | "new";
  headScore: number;
  nowFailing: string[];
  /**
   * How much the entry got worse, used to sort the table. A new entry has no base score to
   * subtract from, so it is scored against a perfect 100: a new entry landing at 60 sorts the
   * same as an existing one that dropped 40 points, which is the ordering "what needs fixing
   * first" implies.
   */
  drop: number;
};

function changedRows(head: MapReport, base: MapReport): { rows: ChangedRow[]; removed: number } {
  const baseByFile = new Map(base.entries.map((e) => [e.fileName, e]));
  const headFiles = new Set(head.entries.map((e) => e.fileName));

  const rows: ChangedRow[] = [];
  for (const h of head.entries) {
    const b = baseByFile.get(h.fileName);
    if (!b) {
      rows.push({
        routePath: h.routePath,
        sensitive: h.sensitive,
        baseScore: "new",
        headScore: h.score,
        nowFailing: failingIds(h),
        drop: 100 - h.score,
      });
      continue;
    }
    if (b.score === h.score) continue;
    const baseFailing = new Set(failingIds(b));
    rows.push({
      routePath: h.routePath,
      sensitive: h.sensitive,
      baseScore: b.score,
      headScore: h.score,
      nowFailing: failingIds(h).filter((id) => !baseFailing.has(id)),
      drop: b.score - h.score,
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.sensitive) - Number(a.sensitive) ||
      b.drop - a.drop ||
      a.routePath.localeCompare(b.routePath)
  );

  const removed = base.entries.filter((e) => !headFiles.has(e.fileName)).length;
  return { rows, removed };
}

function whatChangedSection(head: MapReport, base: MapReport | null): string[] {
  const lines = ["**What this PR changed**"];

  if (!base) {
    lines.push("Base comparison unavailable.");
    return lines;
  }

  const { rows, removed } = changedRows(head, base);

  if (rows.length === 0 && removed === 0) {
    lines.push("No entry point this PR touches changed its score.");
    return lines;
  }

  if (rows.length > 0) {
    lines.push("");
    lines.push("| route | base | head | now failing |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of rows.slice(0, MAX_CHANGED_ROWS)) {
      lines.push(
        `| ${row.routePath} | ${row.baseScore} | ${row.headScore} | ${row.nowFailing.join(", ")} |`
      );
    }
    if (rows.length > MAX_CHANGED_ROWS) {
      lines.push("");
      lines.push(`and ${rows.length - MAX_CHANGED_ROWS} more`);
    }
  }

  if (removed > 0) {
    lines.push("");
    lines.push(`${removed} entries removed`);
  }

  return lines;
}

function fixFirstSection(head: MapReport): string[] {
  const lines = ["FIX FIRST"];
  const worst = head.entries
    .filter((e) => scoredFailures(e).length > 0 && !contextOnly(e))
    .sort(
      (a, b) =>
        Number(b.sensitive) - Number(a.sensitive) ||
        a.score - b.score ||
        a.fileName.localeCompare(b.fileName)
    );

  for (const e of worst.slice(0, 3)) {
    const marks = e.sensitive ? " (sensitive)" : "";
    lines.push(
      `- ${e.routePath}${marks} - ${scoredFailures(e)
        .map((c) => c.id)
        .join(", ")}`
    );
  }
  return lines;
}

/**
 * Pure function, no I/O: `head` and `base` are already-built reports. Matches entries across the
 * two by `fileName`, the same identifier `renderJson` carries.
 */
export function renderPrComment(head: MapReport, base: MapReport | null): string {
  const lines = [MARKER, "", "## Observability map", "", scoreLine(head, base), ""];

  lines.push(...whatChangedSection(head, base), "");
  lines.push(...fixFirstSection(head), "");

  const audit = auditLine(head);
  if (audit) lines.push(audit);
  const context = contextLine(head);
  if (context) lines.push(context);
  if (audit || context) lines.push("");

  lines.push(
    "Report only, nothing here gates the merge. The rules and their reasons: " +
      "internal-packages/observability-map/README.md."
  );

  const headFailures = head.parseFailures.length;
  const baseFailures = base?.parseFailures.length ?? 0;
  if (headFailures > 0 || baseFailures > 0) {
    const parts: string[] = [];
    if (headFailures > 0) parts.push(`${headFailures} at head`);
    if (baseFailures > 0) parts.push(`${baseFailures} at base`);
    lines.push(
      `Warning: parse failures (${parts.join(", ")}) are excluded from the score, shrinking the denominator.`
    );
  }

  return lines.join("\n");
}

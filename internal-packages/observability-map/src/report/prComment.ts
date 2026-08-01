import type { MapReport, ScoredEntry } from "../score.js";
import { SCORED_CHECK_IDS } from "../checks/index.js";
import {
  auditLine,
  contextLine,
  contextOnly,
  scoredFailures,
  unknownSuppressionLines,
} from "./terminal.js";

/** First line of every comment this job posts, so the upsert step can find its own comment again. */
export const MARKER = "<!-- observability-map-report -->";

const MAX_CHANGED_ROWS = 15;

// Scored checks only, same exclusion terminal.ts's scoredFailures makes: audit-trail fails almost
// every sensitive mutation today, so listing it per route would nag with something unfixable
// instead of surfacing the route-specific gaps this column exists for.
const failingIds = (e: ScoredEntry) =>
  e.checks.filter((c) => SCORED_CHECK_IDS.includes(c.id) && c.status === "fail").map((c) => c.id);

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

/** What goes in a score column: a figure, an absence, or no prior entry to compare against. */
const NOT_MEASURED = "not measured";

/**
 * `score` is 100 for an entry no scored check applied to, a placeholder the score itself excludes
 * from every mean. Rendering that 100 as a figure turned a route refactored down to a trivial body
 * into a 67-point improvement, and a trivial route gaining real work into the PR's worst
 * regression. So the cell says what the terminal gauge says for a null mean instead.
 */
const scoreCell = (e: ScoredEntry): number | string => (e.measured ? e.score : NOT_MEASURED);

type ChangedRow = {
  routePath: string;
  sensitive: boolean;
  baseScore: number | string;
  headScore: number | string;
  nowFailing: string[];
  /**
   * How much the entry got worse, used to sort the table. A new entry has no base score to
   * subtract from, so it is scored against a perfect 100: a new entry landing at 60 sorts the
   * same as an existing one that dropped 40 points, which is the ordering "what needs fixing
   * first" implies. Zero whenever either side is unmeasured, because there is no arithmetic to do
   * between a figure and an absence; such a row is in the table to disclose the transition, not to
   * claim a size for it.
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
      // A new entry that passes every check it was measured against has nothing to fix, which is
      // what `drop: 0` means everywhere else in this table. A new entry nothing applied to is a
      // different statement and still gets a row, since its 100 is a placeholder rather than a pass.
      if (h.measured && h.score === 100) continue;
      rows.push({
        routePath: h.routePath,
        sensitive: h.sensitive,
        baseScore: "new",
        headScore: scoreCell(h),
        nowFailing: failingIds(h),
        drop: h.measured ? 100 - h.score : 0,
      });
      continue;
    }
    // Measured state is part of what changed: a measured-to-unmeasured transition can leave the
    // score untouched at its placeholder value, and skipping on the number alone hid it.
    if (b.measured === h.measured && b.score === h.score) continue;
    const baseFailing = new Set(failingIds(b));
    rows.push({
      routePath: h.routePath,
      sensitive: h.sensitive,
      baseScore: scoreCell(b),
      headScore: scoreCell(h),
      nowFailing: failingIds(h).filter((id) => !baseFailing.has(id)),
      drop: b.measured && h.measured ? b.score - h.score : 0,
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
 * Whether this pull request moves the report at all, so the job can stay quiet when it does not.
 *
 * True on: no base to compare against, a global score change, an entry added or removed, an
 * entry's score or measured state changed, a check that fails at head and did not at base, a
 * change in the parse failure count, or a change in the unknown suppression warnings. The last two
 * are here because both render a line in the comment, so a run that gains one has moved the report
 * even though no score did.
 *
 * The residual: adding a suppression whose check was already failing moves nothing this asks
 * about. The score is capped at the pre-suppression ratio so it cannot move, and the finding
 * leaves the fix list quietly. `SUPPRESSED` in the terminal report is where that shows up.
 */
export function hasDelta(head: MapReport, base: MapReport | null): boolean {
  if (!base) return true;
  if (head.global !== base.global) return true;
  if (head.parseFailures.length !== base.parseFailures.length) return true;
  if (JSON.stringify(head.unknownSuppressions) !== JSON.stringify(base.unknownSuppressions)) {
    return true;
  }

  const baseByFile = new Map(base.entries.map((e) => [e.fileName, e]));
  const headFiles = new Set(head.entries.map((e) => e.fileName));
  if (base.entries.some((e) => !headFiles.has(e.fileName))) return true;

  for (const h of head.entries) {
    const b = baseByFile.get(h.fileName);
    if (!b) return true;
    if (b.measured !== h.measured || b.score !== h.score) return true;
    const baseFailing = new Set(b.checks.filter((c) => c.status === "fail").map((c) => c.id));
    if (h.checks.some((c) => c.status === "fail" && !baseFailing.has(c.id))) return true;
  }
  return false;
}

/**
 * What replaces a comment whose findings a later push fixed. Going silent would leave the earlier
 * comment standing with findings that no longer exist, which is worse than a redundant comment.
 */
export function renderResolvedComment(): string {
  return [
    MARKER,
    "",
    "## Observability map",
    "",
    "Nothing in this pull request moves the report any more. The findings an earlier push " +
      "reported are gone.",
    "",
    "Report only, nothing here gates the merge. The rules and their reasons: " +
      "internal-packages/observability-map/README.md.",
  ].join("\n");
}

/**
 * What the job posts when the head scan did not produce a report. The alternative was a red x on
 * a job that must never block a pull request, and the alternative to that was swallowing the
 * failure so the only signal was a comment that never appeared.
 */
export function renderScanFailedComment(): string {
  return [
    MARKER,
    "",
    "## Observability map",
    "",
    "The scan failed for this run, so there is no report. Anything above is from an earlier push " +
      "and is stale. The workflow log has the error.",
    "",
    "Report only, nothing here gates the merge. The rules and their reasons: " +
      "internal-packages/observability-map/README.md.",
  ].join("\n");
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
  const unknown = unknownSuppressionLines(head);
  lines.push(...unknown);
  if (audit || context || unknown.length > 0) lines.push("");

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

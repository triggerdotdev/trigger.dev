import type { MapReport, ScoredEntry } from "../score.js";
import {
  auditLine,
  checkContributionLines,
  contextLine,
  fixFirst,
  delegatedLines,
  scoredFailures,
  unknownSuppressionLines,
} from "./terminal.js";

/** First line of every comment this job posts, so the upsert step can find its own comment again. */
export const MARKER = "<!-- observability-map-report -->";

const MAX_CHANGED_ROWS = 15;

/**
 * A mistyped directive applied tree wide renders one line per file: 87,938 characters against
 * GitHub's 65,536 limit, a 422, and the workflow's error tolerance swallowing it. The cap is what
 * stops the whole comment being lost to the section warning about a typo.
 */
const MAX_UNKNOWN_SUPPRESSION_LINES = 10;

/**
 * The same failure in the other section that grows with the size of the tree. `delegating` holds
 * one file name per route whose body lives elsewhere, joined into a single line, and a codemod that
 * moves route bodies into `.server.ts` modules is both the refactor this feature exists to notice
 * and the one that makes the list tree-sized. The cap was claimed here before it was written: the
 * note above used to open "every other section of this comment is bounded by construction", which
 * was not true of this one.
 *
 * Fifteen matches the changed-entries table rather than the ten above, because a delegating file
 * name is one comma-separated item rather than a line naming every known check. The bound that
 * matters is the section's worst case: the longest route file name in the tree is 130 characters,
 * so fifteen of those plus separators is under 2kB against GitHub's 65,536.
 */
const MAX_DELEGATED_ROUTES = 15;

// Scored checks only, same exclusion terminal.ts's scoredFailures makes: audit-trail fails almost
// every sensitive mutation today, so listing it per route would nag with something unfixable
// instead of surfacing the route-specific gaps this column exists for.
const failingIds = (e: ScoredEntry) => scoredFailures(e).map((c) => c.id);

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

/** Ids suppressed at head that were not suppressed at base. `[]` covers both "no change" and a
 * suppression being removed, which shows up as the score going back up. */
const newlySuppressed = (head: ScoredEntry, base: ScoredEntry | undefined): string[] =>
  head.suppressed.filter((id) => !(base?.suppressed ?? []).includes(id));

type ChangedRow = {
  routePath: string;
  sensitive: boolean;
  baseScore: number | string;
  headScore: number | string;
  nowFailing: string[];
  /**
   * Ids this pull request newly suppressed on the entry. Rendered on the route cell, because a
   * suppression added to a check that was passing drops the score by round A's cap and produces a
   * row with an empty "now failing" column, which is indistinguishable from a real regression:
   * `_app.@.orgs.$organizationSlug.$.tsx` renders 67 to 50 that way. The score movement is honest,
   * the row without this note was not.
   */
  suppressed: string[];
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
      if (h.measured && h.score === 100 && h.suppressed.length === 0) continue;
      rows.push({
        routePath: h.routePath,
        sensitive: h.sensitive,
        baseScore: "new",
        headScore: scoreCell(h),
        nowFailing: failingIds(h),
        suppressed: newlySuppressed(h, b),
        drop: h.measured ? 100 - h.score : 0,
      });
      continue;
    }
    // Measured state and the suppression set are both part of what changed. A measured-to-
    // unmeasured transition can leave the score at its placeholder value, and suppressing a check
    // that was already failing moves no score at all, so skipping on the number alone hid both. A
    // pull request whose whole purpose is to silence findings has to produce a row.
    const suppressed = newlySuppressed(h, b);
    const suppressionChanged = suppressed.length > 0 || h.suppressed.length !== b.suppressed.length;
    if (b.measured === h.measured && b.score === h.score && !suppressionChanged) continue;
    const baseFailing = new Set(failingIds(b));
    rows.push({
      routePath: h.routePath,
      sensitive: h.sensitive,
      baseScore: scoreCell(b),
      headScore: scoreCell(h),
      nowFailing: failingIds(h).filter((id) => !baseFailing.has(id)),
      suppressed,
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
      const note = row.suppressed.length > 0 ? ` (suppressed: ${row.suppressed.join(", ")})` : "";
      lines.push(
        `| ${row.routePath}${note} | ${row.baseScore} | ${row.headScore} | ${row.nowFailing.join(", ")} |`
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
  const worst = fixFirst(head.entries);

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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether this pull request moves the report at all, so the job can stay quiet when it does not.
 *
 * The rule this has to satisfy is that it must be true whenever `renderPrComment` would say
 * something different, because anything it misses is a change the pull request silently does not
 * report. So it covers every figure the comment renders, not only the score: the global, the
 * per-entry score, measured state and suppression set, an entry added or removed, a check failing
 * at head that did not at base, the parse failure count, the unknown suppression warnings, and the
 * audit and context gaps.
 *
 * `delegating` and `checkContributions` are compared outright rather than through the per-entry
 * loop. Both are rendered, and both can move while every entry keeps its score: a check going from
 * applicable-and-passing to not-applicable leaves an entry at 100 and changes what the CHECKS block
 * says about it.
 *
 * The per-entry suppression set and the two gaps are the half that was missing, and it ran the
 * dangerous way. Suppressing an already-failing check moves no score, no measured flag and no new
 * failure, so a pull request whose entire purpose was to silence findings posted nothing, while a
 * mistyped directive did post because the unknown warnings were compared. `audit-trail` going from
 * fail to pass, the first audit record in the webapp, was in the same hole, and so was the CONTEXT
 * figure moving behind a suppression, since that figure reads pre-suppression data.
 *
 * The terms overlap on purpose, and what is defended is that their union is complete rather than
 * that each one is load bearing. Four are individually reachable, each with a test that fails when
 * only that term is removed: the parse failure count, the unknown suppression warnings, the audit
 * gap and the context gap. The global, the removed-entry check and the per-entry score are each
 * shadowed by another term today, and are kept because which term shadows which depends on the
 * shape of the change rather than on anything stable.
 *
 * `MapReport.suppressions` is the one term deliberately left out. Its two totals are summed from
 * the very per-entry `suppressed` arrays the loop below compares one by one, so it cannot move
 * without the loop moving. That is arithmetic rather than a happy overlap.
 */
export function hasDelta(head: MapReport, base: MapReport | null): boolean {
  if (!base) return true;
  if (head.global !== base.global) return true;
  if (head.parseFailures.length !== base.parseFailures.length) return true;
  if (!same(head.unknownSuppressions, base.unknownSuppressions)) return true;
  if (!same(head.auditGap, base.auditGap)) return true;
  if (!same(head.contextGap, base.contextGap)) return true;
  if (!same(head.delegating, base.delegating)) return true;
  if (!same(head.checkContributions, base.checkContributions)) return true;

  const baseByFile = new Map(base.entries.map((e) => [e.fileName, e]));
  const headFiles = new Set(head.entries.map((e) => e.fileName));
  if (base.entries.some((e) => !headFiles.has(e.fileName))) return true;

  for (const h of head.entries) {
    const b = baseByFile.get(h.fileName);
    if (!b) return true;
    if (b.measured !== h.measured || b.score !== h.score) return true;
    if (!same(h.suppressed, b.suppressed)) return true;
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
  const delegated = delegatedLines(head, MAX_DELEGATED_ROUTES);
  lines.push(...delegated);
  const unknown = unknownSuppressionLines(head);
  lines.push(...unknown.slice(0, MAX_UNKNOWN_SUPPRESSION_LINES));
  if (unknown.length > MAX_UNKNOWN_SUPPRESSION_LINES) {
    lines.push(`and ${unknown.length - MAX_UNKNOWN_SUPPRESSION_LINES} more files with unknown ids`);
  }
  if (audit || context || delegated.length > 0 || unknown.length > 0) lines.push("");

  const contributions = checkContributionLines(head);
  if (contributions.length > 0) {
    lines.push("<details><summary>What the score is made of</summary>", "", "```");
    lines.push(...contributions);
    lines.push("```", "", "</details>", "");
  }

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

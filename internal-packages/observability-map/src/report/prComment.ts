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
const MARKER = "<!-- observability-map-report -->";

/**
 * The commit a comment was rendered for. Data rather than something the renderers read for themselves,
 * so they stay pure and a run with no commit context renders the same comment without the line.
 */
export type CommitContext = {
  /** The head sha, full. Shortened for the link text here rather than by the caller. */
  sha: string;
  /** Compare URL for the pull request's range, base to head. */
  url: string;
};

const SHORT_SHA_LENGTH = 7;

/**
 * Closes every comment this job posts. The second sentence is there because the package's own test
 * suite does gate webapp pull requests, and a blocked author's first stop is this footer, which used
 * to tell them nothing gates anything.
 */
const FOOTER =
  "The score and findings here are report-only and never gate the merge. Separately, a required " +
  "test suite keeps this tool's symbol and route lists in sync with the code they name, and can " +
  "fail a pull request that renames or removes a symbol they reference, or that adds the first " +
  "route with a segment they anticipate. Each failure names the list to edit. The rules and their " +
  "reasons: internal-packages/observability-map/README.md.";

/** Directly under the heading, because the comment is edited in place across pushes and the first
 * question about it is which push it reflects. */
function commitLines(commit: CommitContext | undefined): string[] {
  if (!commit) return [];
  return [`As of [\`${commit.sha.slice(0, SHORT_SHA_LENGTH)}\`](${commit.url}).`, ""];
}

const MAX_CHANGED_ROWS = 15;

/** A mistyped directive applied tree wide rendered 87,938 characters against GitHub's 65,536 limit,
 * so the whole comment was lost to the section warning about a typo. */
const MAX_UNKNOWN_SUPPRESSION_LINES = 10;

/**
 * The same failure in the other section that grows with the tree, since a codemod moving route bodies
 * into `.server.ts` modules is both the refactor this feature exists to notice and the one that makes
 * the list tree-sized. Fifteen rather than the ten above because a file name is one comma-separated
 * item: the longest in the tree is 130 characters, so fifteen of those is under 2kB.
 */
const MAX_DELEGATED_ROUTES = 15;

// Scored checks only, the same exclusion `scoredFailures` makes.
const failingIds = (e: ScoredEntry) => scoredFailures(e).map((c) => c.id);

function scoreLine(head: MapReport, base: MapReport | null): string {
  const headline =
    head.global === null
      ? `not measured over ${head.measured} measured of ${head.entries.length} entry points`
      : `**${head.global}/100** over ${head.measured} measured of ${head.entries.length} entry points`;

  if (!base) return headline;
  // Head first: when this side has no score the headline already says so, and naming the base as the
  // missing one sends the reader to the wrong commit.
  if (head.global === null) return `${headline} (base ${base.global ?? "not measured"})`;
  if (base.global === null) return `${headline} (base not measured)`;

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
 * `score` is a placeholder 100 for an entry no scored check applied to. Rendering that as a figure
 * turned a route refactored down to a trivial body into a 67-point improvement, and a trivial route
 * gaining real work into the PR's worst regression.
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
  /** Ids this pull request newly suppressed. Rendered on the route cell, because a suppression added
   * to a passing check drops the score by the cap and produces a row with an empty "now failing"
   * column, indistinguishable from a real regression. */
  suppressed: string[];
  /** How much the entry got worse, used to sort the table. A new entry is scored against a perfect
   * 100, so one landing at 60 sorts with an existing one that dropped 40. Zero whenever either side
   * is unmeasured, since there is no arithmetic to do between a figure and an absence. */
  drop: number;
};

function changedRows(head: MapReport, base: MapReport): { rows: ChangedRow[]; removed: number } {
  const baseByFile = new Map(base.entries.map((e) => [e.fileName, e]));
  const headFiles = new Set(head.entries.map((e) => e.fileName));

  const rows: ChangedRow[] = [];
  for (const h of head.entries) {
    const b = baseByFile.get(h.fileName);
    if (!b) {
      // A new entry passing every check it was measured against has nothing to fix. One nothing
      // applied to still gets a row, since its 100 is a placeholder rather than a pass.
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
    // Measured state and the suppression set are both part of what changed: a measured-to-unmeasured
    // transition can leave the score at its placeholder, and suppressing an already-failing check
    // moves no score at all, so skipping on the number alone hid both.
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
 * This has to be true whenever `renderPrComment` would say something different, because anything it
 * misses is a change the pull request silently does not report. The terms overlap on purpose, and
 * what is defended is that their union is complete rather than that each one is load bearing.
 * `MapReport.suppressions` is the one term deliberately left out, because its totals are summed from
 * the very per-entry arrays the loop below compares. See INTERNALS.md, "Reporting".
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

/** What replaces a comment whose findings a later push fixed. Going silent leaves the earlier comment
 * standing with findings that no longer exist. */
export function renderResolvedComment(commit?: CommitContext): string {
  return [
    MARKER,
    "",
    "## Observability map",
    "",
    ...commitLines(commit),
    "Nothing in this pull request moves the report any more. The findings an earlier push " +
      "reported are gone.",
    "",
    FOOTER,
  ].join("\n");
}

/**
 * What the job posts when the head scan did not produce a report. The alternatives were a red x on a
 * job that must never block a pull request, or swallowing the failure so the only signal was a comment
 * that never appeared.
 */
export function renderScanFailedComment(commit?: CommitContext): string {
  return [
    MARKER,
    "",
    "## Observability map",
    "",
    ...commitLines(commit),
    "The scan failed for this run, so there is no report. Anything above is from an earlier push " +
      "and is stale. The workflow log has the error.",
    "",
    FOOTER,
  ].join("\n");
}

/** Pure function, no I/O: `head` and `base` are already-built reports, matched by `fileName`. */
export function renderPrComment(
  head: MapReport,
  base: MapReport | null,
  commit?: CommitContext
): string {
  const lines = [
    MARKER,
    "",
    "## Observability map",
    "",
    ...commitLines(commit),
    scoreLine(head, base),
    "",
  ];

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

  lines.push(FOOTER);

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

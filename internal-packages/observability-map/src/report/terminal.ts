import type { MapReport, ScoredEntry } from "../score.js";
import { SCORED_CHECK_IDS } from "../checks/index.js";

const NOT_MEASURED = "not measured".padEnd(15);

/** A bar and a figure, or a plain "not measured" where there is no figure to draw. */
const gauge = (score: number | null) => {
  if (score === null) return NOT_MEASURED;
  const filled = Math.round(score / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${String(score).padStart(3)}`;
};

/**
 * Failing checks that actually feed `score`. `audit-trail` is deliberately excluded here: it is
 * excluded from the score for the same reason (see `score.ts`), and every sensitive mutation fails
 * it today, so folding it in would flood this list with the same finding repeated 52 times instead
 * of the fixable, route-specific gaps the list exists to surface. That gap is reported once, as
 * `AUDIT`, below.
 */
export const scoredFailures = (e: ScoredEntry) =>
  e.checks.filter((c) => SCORED_CHECK_IDS.includes(c.id) && c.status === "fail");

/**
 * An entry whose only finding is `request-context`. 391 of 412 entry points fail that check, so
 * listing each one turns the fix list into a single house-style finding repeated, which is the
 * reason `audit-trail` is kept out of the list too. Collapsed into the `CONTEXT` figure instead.
 * An entry that fails something else as well stays in the list with all of its findings, so a
 * route like `/account/tokens` still shows the request-context gap alongside the rest.
 */
export const contextOnly = (e: ScoredEntry) => {
  const failures = scoredFailures(e);
  return failures.length === 1 && failures[0]!.id === "request-context";
};

/** The AUDIT figure, shared with `prComment.ts` so both renderers say the same thing. Null when
 * there is nothing to report, i.e. no sensitive mutation exists. */
export function auditLine(report: MapReport): string | null {
  const { sensitiveMutations, withAudit } = report.auditGap;
  if (sensitiveMutations === 0) return null;
  // The closing sentence is a claim about the codebase, so it is only made when the figure in
  // front of it supports it. It was printed unconditionally, including next to a non-zero count.
  const gap =
    withAudit === 0
      ? " No audit helper exists in the webapp."
      : ` ${sensitiveMutations - withAudit} without one.`;
  return `AUDIT   ${withAudit} of ${sensitiveMutations} sensitive mutations record an actor.${gap}`;
}

/** The CONTEXT figure, shared with `prComment.ts`. Null when nothing is applicable. */
export function contextLine(report: MapReport): string | null {
  const { applicable, naming } = report.contextGap;
  if (applicable === 0) return null;
  const collapsed = report.entries.filter(contextOnly);
  const sensitive = collapsed.filter((e) => e.sensitive).length;
  return (
    `CONTEXT   ${naming} of ${applicable} entry points name a tenant on a failure path.` +
    (collapsed.length > 0
      ? ` ${collapsed.length} appear${collapsed.length === 1 ? "s" : ""} only here, ` +
        `${sensitive} of them sensitive, in the JSON rather than the list below.`
      : "")
  );
}

export function renderTerminal(report: MapReport): string {
  const lines: string[] = [];

  const headline = report.global === null ? "score not measured" : `score ${report.global}/100`;
  lines.push(
    `${headline}   ${report.measured} measured, ${report.unmeasured} unmeasured of ${report.entries.length} entry points`
  );
  lines.push("");
  lines.push("COVERAGE");
  for (const [family, stats] of Object.entries(report.byFamily).sort((a, b) => b[1].n - a[1].n)) {
    lines.push(
      `  ${family.padEnd(12)} ${gauge(stats.mean)}   ${stats.measured}/${stats.n} entry points`
    );
  }
  lines.push(
    `  ${"sensitive".padEnd(12)} ${gauge(report.sensitiveCohort.mean)}   ${
      report.sensitiveCohort.measured
    }/${report.sensitiveCohort.n} entry points`
  );

  const audit = auditLine(report);
  if (audit) {
    lines.push("");
    lines.push(audit);
  }

  const context = contextLine(report);
  if (context) {
    lines.push("");
    lines.push(context);
  }

  if (report.suppressions.checks > 0) {
    const { entries, checks } = report.suppressions;
    lines.push(
      `SUPPRESSED   ${checks} check${checks === 1 ? "" : "s"} across ${entries} entry point${
        entries === 1 ? "" : "s"
      }, each with a reason on the record. A suppression removes a finding from this list, ` +
        `it does not raise a score.`
    );
  }

  const worst = report.entries
    .filter((e) => scoredFailures(e).length > 0 && !contextOnly(e))
    .sort(
      (a, b) =>
        Number(b.sensitive) - Number(a.sensitive) ||
        a.score - b.score ||
        a.fileName.localeCompare(b.fileName)
    );

  lines.push("");
  lines.push("FIX FIRST");
  for (const e of worst.slice(0, 3)) {
    const marks = e.sensitive ? " (sensitive)" : "";
    lines.push(
      `  ${e.routePath}${marks} - ${scoredFailures(e)
        .map((c) => c.id)
        .join(", ")}`
    );
    lines.push(`    ${e.fileName}`);
  }
  if (worst.length > 3) {
    lines.push("");
    lines.push(`THEN   ${worst.length - 3} more with gaps`);
  }

  lines.push("");
  // Not one flattering number: an entry with nothing applicable is not the same as an entry that
  // passed, and lumping them together counted routes as solid for doing nothing.
  const clean = report.entries.filter((e) => e.measured && scoredFailures(e).length === 0).length;
  lines.push(
    `no findings: ${clean} passed every applicable check, ${report.unmeasured} had none to apply`
  );
  if (report.parseFailures.length > 0) {
    lines.push(`parse failures (excluded from the score): ${report.parseFailures.join(", ")}`);
  }
  return lines.join("\n");
}

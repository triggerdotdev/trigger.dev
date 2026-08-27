import type { MapReport, ScoredEntry } from "../score.js";
import { CHECKS, SCORED_CHECK_IDS } from "../checks/index.js";

const NOT_MEASURED = "not measured".padEnd(15);

/** A bar and a figure, or a plain "not measured" where there is no figure to draw. */
const gauge = (score: number | null) => {
  if (score === null) return NOT_MEASURED;
  const filled = Math.round(score / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${String(score).padStart(3)}`;
};

/** Failing checks that feed `score`, so never `audit-trail`: every sensitive mutation fails that
 * today, and it is reported once as the `AUDIT` line instead. */
export const scoredFailures = (e: ScoredEntry) =>
  e.checks.filter((c) => SCORED_CHECK_IDS.includes(c.id) && c.status === "fail");

/**
 * The routes the FIX FIRST list is drawn from, worst first: sensitive before not, then by score, then
 * by name. Exported because `prComment.ts` renders the same list with different bullets and had a
 * byte-identical copy of this filter and sort.
 */
export const fixFirst = (entries: ScoredEntry[]): ScoredEntry[] =>
  entries
    .filter((e) => scoredFailures(e).length > 0 && !contextOnly(e))
    .sort(
      (a, b) =>
        Number(b.sensitive) - Number(a.sensitive) ||
        a.score - b.score ||
        a.fileName.localeCompare(b.fileName)
    );

/** An entry whose only finding is `request-context`, which fails almost everything, so it is
 * collapsed into the `CONTEXT` figure rather than listed. An entry that fails something else as well
 * keeps all of its findings and stays in the list. */
const contextOnly = (e: ScoredEntry) => {
  const failures = scoredFailures(e);
  return failures.length === 1 && failures[0]!.id === "request-context";
};

/**
 * The UNKNOWN SUPPRESSION lines, one per file, shared with `prComment.ts`. A typo suppresses nothing,
 * so without this the author reads the finding as acknowledged and the tool goes on reporting it.
 */
export function unknownSuppressionLine(fileName: string, ids: string[]): string {
  return (
    `UNKNOWN SUPPRESSION   ${fileName}: ${ids.join(", ")} ` +
    `(no such check, nothing suppressed). Known: ${CHECKS.map((c) => c.id).join(", ")}.`
  );
}

export function unknownSuppressionLines(report: MapReport): string[] {
  return report.unknownSuppressions.map(({ fileName, ids }) =>
    unknownSuppressionLine(fileName, ids)
  );
}

/**
 * The AUDIT figure, shared with `prComment.ts` so both renderers say the same thing. Null when no
 * sensitive mutation exists. One shape for every count and no branch on the count, because the branch
 * is what carried the bug: a zero used to print "No audit helper exists in the webapp", which is
 * false. "0 of N record an actor" already says what a zero means.
 */
export function auditLine(report: MapReport): string | null {
  const { sensitiveMutations, withAudit } = report.auditGap;
  if (sensitiveMutations === 0) return null;
  return (
    `AUDIT   ${withAudit} of ${sensitiveMutations} sensitive mutations record an actor. ` +
    `${sensitiveMutations - withAudit} without one.`
  );
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
        `${sensitive} of them sensitive, in the JSON rather than the fix list.`
      : "")
  );
}

/**
 * The DELEGATED lines, shared with `prComment.ts`. Worded as a shortfall rather than a note: these
 * routes left the denominator and no check looked at any of them. `limit` shortens the evidence for a
 * caller with a size limit; the count in front of the list is always the full one.
 */
export function delegatedLines(report: MapReport, limit = Infinity): string[] {
  if (report.delegating.length === 0) return [];
  const n = report.delegating.length;
  const shown = report.delegating.slice(0, limit);
  const tail = n > shown.length ? `, and ${n - shown.length} more` : "";
  return [
    `DELEGATED   ${n} route${n === 1 ? "" : "s"} keep${n === 1 ? "s" : ""} the body in another ` +
      `module, so nothing here was checked and ${n === 1 ? "it is" : "they are"} out of the score: ` +
      shown.join(", ") +
      tail,
  ];
}

/** The CHECKS block: what the composite is made of. `sole` is the figure that says most, since an
 * entry only one scored check applies to scores 0 or 100 on that one boolean. */
export function checkContributionLines(report: MapReport): string[] {
  if (report.checkContributions.every((c) => c.applicable === 0)) return [];
  const width = Math.max(...report.checkContributions.map((c) => c.id.length));
  return [
    "CHECKS",
    ...report.checkContributions.map((c) => {
      const worth = !c.scored
        ? "not in the score"
        : c.globalWithout === null
          ? "nothing left measured without it"
          : `global without it ${c.globalWithout}`;
      return (
        `  ${c.id.padEnd(width)}  ${String(c.applicable).padStart(3)} applicable, ` +
        `${String(c.passed).padStart(3)} pass, ${String(c.sole).padStart(3)} sole, ${worth}`
      );
    }),
  ];
}

export function renderTerminal(report: MapReport): string {
  const lines: string[] = [];

  const headline = report.global === null ? "score not measured" : `score ${report.global}/100`;
  const delegatedCount =
    report.delegating.length > 0 ? `, ${report.delegating.length} delegated` : "";
  lines.push(
    `${headline}   ${report.measured} measured, ${report.unmeasured} unmeasured${delegatedCount} of ${report.entries.length} entry points`
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

  const contributions = checkContributionLines(report);
  if (contributions.length > 0) {
    lines.push("");
    lines.push(...contributions);
  }

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

  const delegated = delegatedLines(report);
  if (delegated.length > 0) {
    lines.push("");
    lines.push(...delegated);
  }

  const unknown = unknownSuppressionLines(report);
  if (unknown.length > 0) {
    lines.push("");
    lines.push(...unknown);
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

  const worst = fixFirst(report.entries);

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
  // Two figures rather than one, because lumping "nothing applicable" in with "passed" counted routes
  // as solid for doing nothing.
  const clean = report.entries.filter((e) => e.measured && scoredFailures(e).length === 0).length;
  lines.push(
    `no findings: ${clean} passed every applicable check, ${report.unmeasured} had none to apply`
  );
  if (report.parseFailures.length > 0) {
    lines.push(`parse failures (excluded from the score): ${report.parseFailures.join(", ")}`);
  }
  return lines.join("\n");
}

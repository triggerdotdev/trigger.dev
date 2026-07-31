import type { MapReport, ScoredEntry } from "../score.js";
import { SCORED_CHECK_IDS } from "../checks/index.js";

const bar = (score: number) => {
  const filled = Math.round(score / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
};

/**
 * Failing checks that actually feed `score`. `audit-trail` is deliberately excluded here: it is
 * excluded from the score for the same reason (see `score.ts`), and every sensitive mutation fails
 * it today, so folding it in would flood this list with the same finding repeated 52 times instead
 * of the fixable, route-specific gaps the list exists to surface. That gap is reported once, as
 * `AUDIT`, below.
 */
const scoredFailures = (e: ScoredEntry) =>
  e.checks.filter((c) => SCORED_CHECK_IDS.includes(c.id) && c.status === "fail");

export function renderTerminal(report: MapReport): string {
  const lines: string[] = [];

  lines.push(
    `score ${report.global}/100   ${report.measured} measured, ${report.unmeasured} unmeasured of ${report.entries.length} entry points`
  );
  lines.push("");
  lines.push("COVERAGE");
  for (const [family, stats] of Object.entries(report.byFamily).sort((a, b) => b[1].n - a[1].n)) {
    lines.push(
      `  ${family.padEnd(12)} ${bar(stats.mean)} ${String(stats.mean).padStart(3)}   ${stats.measured}/${stats.n} entry points`
    );
  }
  lines.push(
    `  ${"sensitive".padEnd(12)} ${bar(report.sensitiveCohort.mean)} ${String(
      report.sensitiveCohort.mean
    ).padStart(3)}   ${report.sensitiveCohort.measured}/${report.sensitiveCohort.n} entry points`
  );

  lines.push("");
  const { sensitiveMutations, withAudit } = report.auditGap;
  lines.push(
    `AUDIT   ${withAudit} of ${sensitiveMutations} sensitive mutations record an actor. ` +
      `No audit helper exists in the webapp.`
  );

  const worst = report.entries
    .filter((e) => scoredFailures(e).length > 0)
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
  lines.push(`already solid: ${report.entries.length - worst.length}`);
  if (report.parseFailures.length > 0) {
    lines.push(`parse failures (excluded from the score): ${report.parseFailures.join(", ")}`);
  }
  return lines.join("\n");
}

import type { CheckResult, EntryPoint } from "./types.js";
import { CHECKS, SCORED_CHECK_IDS } from "./checks/index.js";
import { suppressedChecks } from "./suppression.js";
import { familyOf, routePathOf, type Family } from "./adapters/remix.js";
import { classifySensitivity } from "./sensitivity.js";

export type ScoredEntry = {
  fileName: string;
  routePath: string;
  family: Family;
  sensitive: boolean;
  checks: CheckResult[];
  /**
   * Whether at least one scored check (`SCORED_CHECK_IDS`, so never `audit-trail`) was applicable.
   * `false` means nothing was measured here: the 100 in `score` is a vacuous default, not a
   * finding, and `buildReport` excludes an unmeasured entry from every mean it computes so that
   * default cannot inflate a figure nobody checked.
   */
  measured: boolean;
  /** Passed over applicable, across scored checks only. 100 when nothing applies. */
  score: number;
};

export type MapReport = {
  global: number;
  /** Entry points with at least one applicable scored check, i.e. those `global` is averaged over. */
  measured: number;
  /** Entry points every scored check reported not-applicable for; excluded from `global`. */
  unmeasured: number;
  byFamily: Record<string, { n: number; measured: number; mean: number }>;
  sensitiveCohort: { n: number; measured: number; mean: number };
  auditGap: { sensitiveMutations: number; withAudit: number };
  entries: ScoredEntry[];
  parseFailures: string[];
};

export function scoreEntry(ep: EntryPoint): ScoredEntry {
  const suppressed = suppressedChecks(ep.source);
  const checks = CHECKS.map((c) => {
    const result = c.run(ep);
    const reason = suppressed.get(c.id);
    // A suppression always lands on not-applicable, never on pass: suppressing a check must remove
    // it from the score, not launder it into a point in the entry's favor.
    return reason
      ? { id: c.id, status: "not-applicable" as const, detail: `suppressed: ${reason}` }
      : result;
  });

  const scored = checks.filter((c) => SCORED_CHECK_IDS.includes(c.id));
  const applicable = scored.filter((c) => c.status !== "not-applicable");
  const passed = applicable.filter((c) => c.status === "pass").length;

  return {
    fileName: ep.fileName,
    routePath: routePathOf(ep.fileName),
    family: familyOf(ep.fileName),
    sensitive: classifySensitivity(ep).sensitive,
    checks,
    measured: applicable.length > 0,
    score: applicable.length === 0 ? 100 : Math.round((passed / applicable.length) * 100),
  };
}

const mean = (xs: number[]) =>
  xs.length === 0 ? 100 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * `n` is every entry point in the group; `mean` is taken over the measured subset only, so an
 * entry point nothing applied to cannot drag a family's or cohort's figure toward 100. `measured`
 * is reported alongside so a reader can tell a family scoring high because it is clean apart from
 * a family scoring high because most of it was never measured.
 */
function groupStats(entries: ScoredEntry[]): { n: number; measured: number; mean: number } {
  const measuredEntries = entries.filter((e) => e.measured);
  return {
    n: entries.length,
    measured: measuredEntries.length,
    mean: mean(measuredEntries.map((e) => e.score)),
  };
}

export function buildReport(eps: EntryPoint[], parseFailures: string[]): MapReport {
  const entries = eps.map(scoreEntry);
  const measuredEntries = entries.filter((e) => e.measured);

  const byFamily: Record<string, { n: number; measured: number; mean: number }> = {};
  for (const family of new Set(entries.map((e) => e.family))) {
    byFamily[family] = groupStats(entries.filter((e) => e.family === family));
  }

  const sensitive = entries.filter((e) => e.sensitive);

  // audit-trail is excluded from the score (see checks/index.ts and scoreEntry above), and is
  // reported here as its own architectural figure instead: how many sensitive mutations have an
  // audit record, out of how many. Folding it into the score would tank every sensitive route on a
  // gap that is the same everywhere, and bury the routes that have their own, fixable problems.
  const auditApplicable = entries.filter((e) =>
    e.checks.some((c) => c.id === "audit-trail" && c.status !== "not-applicable")
  );

  return {
    global: mean(measuredEntries.map((e) => e.score)),
    measured: measuredEntries.length,
    unmeasured: entries.length - measuredEntries.length,
    byFamily,
    sensitiveCohort: groupStats(sensitive),
    auditGap: {
      sensitiveMutations: auditApplicable.length,
      withAudit: auditApplicable.filter((e) =>
        e.checks.some((c) => c.id === "audit-trail" && c.status === "pass")
      ).length,
    },
    entries,
    parseFailures,
  };
}

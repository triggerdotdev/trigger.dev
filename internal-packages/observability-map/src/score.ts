import type { CheckResult, EntryPoint } from "./types.js";
import { CHECKS, SCORED_CHECK_IDS } from "./checks/index.js";
import { parseSuppressions } from "./suppression.js";
import { familyOf, routePathOf, type Family } from "./adapters/remix.js";
import { classifySensitivity } from "./sensitivity.js";

export type ScoredEntry = {
  fileName: string;
  routePath: string;
  family: Family;
  sensitive: boolean;
  /** The route's body is in another module, so every check reads not-applicable for that reason.
   * Carried apart from `measured` because "we could not see it" and "nothing happened to apply" are
   * different facts and the report has to be able to say which. */
  delegating: boolean;
  /** Post-suppression display view. Every denominator reads `rawChecks` instead. */
  checks: CheckResult[];
  /** Every check exactly as it ran. The one true source for any figure that counts applicability. */
  rawChecks: CheckResult[];
  /** Whether at least one scored check was applicable BEFORE suppression, so a fully suppressed
   * entry stays measured at its capped score. False means the 100 in `score` is a vacuous default
   * rather than a finding, and every mean excludes it. */
  measured: boolean;
  /** Every check a comment in the source suppressed, scored or not, in `CHECKS` order. */
  suppressed: string[];
  /** Ids in a directive that name no check, so they suppress nothing. Carried so the renderers can
   * say so: dropping them silently made a typo look like an acknowledgement. */
  unknownSuppressions: string[];
  /** Passed over applicable, across scored checks only. 100 when nothing applies. */
  score: number;
};

/**
 * What one check contributes to the composite. Disclosed rather than weighted, deliberately: see
 * README, "What the score is made of".
 */
type CheckContribution = {
  id: string;
  /** Entry points the check was applicable to, pre-suppression. */
  applicable: number;
  /** Of those, how many passed. */
  passed: number;
  /** Whether the check feeds `global` at all. `audit-trail` does not, see `buildReport`. */
  scored: boolean;
  /** Entry points this was the ONLY applicable scored check for, so their score is its verdict and
   * nothing else. Zero for a check that is not scored. */
  sole: number;
  /** The global recomputed with this check out of the scored set, so the difference from `global` is
   * what the check is worth. Null when it is not scored, or when nothing would be left measured. */
  globalWithout: number | null;
};

export type MapReport = {
  /** Null when no entry point had an applicable scored check: an absent figure, not a perfect one. */
  global: number | null;
  /** Entry points with at least one applicable scored check, i.e. those `global` is averaged over. */
  measured: number;
  /** Entry points every scored check reported not-applicable for; excluded from `global`. Counts
   * only routes the scanner could read: a delegating one is in `delegating` instead. */
  unmeasured: number;
  /** Routes whose body is in another module, by file name. Excluded from `global` for the same reason
   * a parse failure is, and reported for the same reason: the denominator is smaller than the entry
   * point count and nothing about these routes has been checked. */
  delegating: string[];
  /** Per-check applicability, pass rate and worth, in `CHECKS` order. */
  checkContributions: CheckContribution[];
  /** Suppressions in force: how many entry points carry one, and how many scored checks in total. */
  suppressions: { entries: number; checks: number };
  /** Suppression directives naming no check, per file, so a typo is reported rather than dropped. */
  unknownSuppressions: { fileName: string; ids: string[] }[];
  byFamily: Record<string, { n: number; measured: number; mean: number | null }>;
  sensitiveCohort: { n: number; measured: number; mean: number | null };
  auditGap: { sensitiveMutations: number; withAudit: number };
  /** Reported as a figure rather than as hundreds of identical list entries, the same treatment
   * `audit-trail` gets, while staying fully in the score. */
  contextGap: { applicable: number; naming: number };
  entries: ScoredEntry[];
  parseFailures: string[];
};

/**
 * What every check reports for a route whose body is in another module. Answered here rather than in
 * each check, because it is a fact about what the scan could see and not about any one question, so
 * no check tests `ep.delegating` itself. Two did, and both branches were unreachable.
 */
const DELEGATED_CHECKS = (): CheckResult[] =>
  CHECKS.map((c) => ({
    id: c.id,
    status: "not-applicable" as const,
    detail: "delegates its body to another module",
  }));

export function scoreEntry(ep: EntryPoint): ScoredEntry {
  const { byId: suppressed, unknown } = parseSuppressions(ep.source, ep.fileName);
  const raw = ep.delegating ? DELEGATED_CHECKS() : CHECKS.map((c) => c.run(ep));
  const checks = raw.map((result) => {
    const reason = suppressed.get(result.id);
    return reason
      ? { id: result.id, status: "not-applicable" as const, detail: `suppressed: ${reason}` }
      : result;
  });

  const scored = raw.filter((c) => SCORED_CHECK_IDS.includes(c.id));
  const ratio = (of: CheckResult[]) => {
    const applicable = of.filter((c) => c.status !== "not-applicable");
    if (applicable.length === 0) return 100;
    return Math.round(
      (applicable.filter((c) => c.status === "pass").length / applicable.length) * 100
    );
  };

  const visible = scored.filter((c) => !suppressed.has(c.id));
  const scoredApplicable = scored.filter((c) => c.status !== "not-applicable");

  return {
    fileName: ep.fileName,
    routePath: routePathOf(ep.fileName),
    family: familyOf(ep.fileName),
    sensitive: classifySensitivity(ep).sensitive,
    delegating: ep.delegating,
    checks,
    rawChecks: raw,
    suppressed: raw.filter((c) => suppressed.has(c.id)).map((c) => c.id),
    unknownSuppressions: unknown,
    measured: scoredApplicable.length > 0,
    // Capped by the pre-suppression ratio, or removing a failing check from both numerator and
    // denominator raises it, which is how 33 became 50 became 100 before the cap existed.
    score: Math.min(ratio(visible), ratio(scored)),
  };
}

/** Null for an empty group rather than 100: rendering the absence as a full green bar said the
 * opposite of what the data said. */
const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * `n` is every entry point in the group; `mean` is over the measured subset only. `measured` is
 * reported alongside so a reader can tell a family scoring high because it is clean from one scoring
 * high because most of it was never measured.
 */
function groupStats(entries: ScoredEntry[]): {
  n: number;
  measured: number;
  mean: number | null;
} {
  const measuredEntries = entries.filter((e) => e.measured);
  return {
    n: entries.length,
    measured: measuredEntries.length,
    mean: mean(measuredEntries.map((e) => e.score)),
  };
}

/**
 * The global as it would read with `omitted` out of the scored set. Recomputed from `rawChecks` minus
 * the suppression cap, because lowering both figures by the same rule would leave the difference
 * saying something about suppressions rather than about the check.
 */
function globalWithout(entries: ScoredEntry[], omitted: string): number | null {
  const scores: number[] = [];
  for (const e of entries) {
    const applicable = e.rawChecks.filter(
      (c) => SCORED_CHECK_IDS.includes(c.id) && c.id !== omitted && c.status !== "not-applicable"
    );
    if (applicable.length === 0) continue;
    const passed = applicable.filter((c) => c.status === "pass").length;
    scores.push(Math.round((passed / applicable.length) * 100));
  }
  return mean(scores);
}

function checkContributions(entries: ScoredEntry[]): CheckContribution[] {
  return CHECKS.map((check) => {
    const results = entries
      .map((e) => e.rawChecks.find((c) => c.id === check.id))
      .filter((c): c is CheckResult => c !== undefined && c.status !== "not-applicable");
    const scored = SCORED_CHECK_IDS.includes(check.id);
    return {
      id: check.id,
      applicable: results.length,
      passed: results.filter((c) => c.status === "pass").length,
      scored,
      sole: scored
        ? entries.filter((e) => {
            const applicable = e.rawChecks.filter(
              (c) => SCORED_CHECK_IDS.includes(c.id) && c.status !== "not-applicable"
            );
            return applicable.length === 1 && applicable[0]!.id === check.id;
          }).length
        : 0,
      globalWithout: scored ? globalWithout(entries, check.id) : null,
    };
  });
}

export function buildReport(eps: EntryPoint[], parseFailures: string[]): MapReport {
  const entries = eps.map(scoreEntry);
  const measuredEntries = entries.filter((e) => e.measured);

  const byFamily: MapReport["byFamily"] = {};
  for (const family of new Set(entries.map((e) => e.family))) {
    byFamily[family] = groupStats(entries.filter((e) => e.family === family));
  }

  const sensitive = entries.filter((e) => e.sensitive);

  // Both gaps read `rawChecks`, pre-suppression: suppressing the one finding on an entry must not
  // shrink these denominators and raise the printed percentage, on the same screen as a claim that
  // suppression cannot do that.
  const contextChecks = entries
    .map((e) => e.rawChecks.find((c) => c.id === "request-context"))
    .filter((c): c is CheckResult => c !== undefined && c.status !== "not-applicable");

  const auditApplicable = entries.filter((e) =>
    e.rawChecks.some((c) => c.id === "audit-trail" && c.status !== "not-applicable")
  );

  const suppressing = entries.filter((e) => e.suppressed.length > 0);

  return {
    global: mean(measuredEntries.map((e) => e.score)),
    measured: measuredEntries.length,
    unmeasured: entries.filter((e) => !e.measured && !e.delegating).length,
    delegating: entries.filter((e) => e.delegating).map((e) => e.fileName),
    checkContributions: checkContributions(entries),
    suppressions: {
      entries: suppressing.length,
      checks: suppressing.reduce((n, e) => n + e.suppressed.length, 0),
    },
    unknownSuppressions: entries
      .filter((e) => e.unknownSuppressions.length > 0)
      .map((e) => ({ fileName: e.fileName, ids: e.unknownSuppressions })),
    byFamily,
    sensitiveCohort: groupStats(sensitive),
    auditGap: {
      sensitiveMutations: auditApplicable.length,
      withAudit: auditApplicable.filter((e) =>
        e.rawChecks.some((c) => c.id === "audit-trail" && c.status === "pass")
      ).length,
    },
    contextGap: {
      applicable: contextChecks.length,
      naming: contextChecks.filter((c) => c.status === "pass").length,
    },
    entries,
    parseFailures,
  };
}

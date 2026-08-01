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
  /** Post-suppression: a suppressed check reads `not-applicable` here, with the reason in
   * `detail`. This is the display view; every denominator below reads `rawChecks` instead, so a
   * suppression is never invisible to a published figure just because its check is not scored. */
  checks: CheckResult[];
  /** Every check exactly as it ran, before a suppression comment can turn a result into
   * `not-applicable`. The one true source for any figure that counts applicability: `measured`
   * below, and `contextGap`/`auditGap` in `MapReport`, which read this rather than `checks` for
   * exactly that reason. */
  rawChecks: CheckResult[];
  /**
   * Whether at least one scored check (`SCORED_CHECK_IDS`, so never `audit-trail`) was applicable
   * before suppression. A fully-suppressed entry stays measured, at its capped score, so a
   * suppression cannot buy removal from every mean by way of removal from this one.
   * `false` means nothing was measured here: the 100 in `score` is a vacuous default, not a
   * finding, and `buildReport` excludes an unmeasured entry from every mean it computes so that
   * default cannot inflate a figure nobody checked.
   */
  measured: boolean;
  /** Every check a comment in the source suppressed, scored or not, in `CHECKS` order. Includes
   * `audit-trail`: a suppression is real regardless of whether its check feeds the score. */
  suppressed: string[];
  /** Ids in a suppression directive that name no check, so they suppress nothing. Carried here so
   * the renderers can say so: dropping them silently is what made a typo look like an
   * acknowledgement. */
  unknownSuppressions: string[];
  /** Passed over applicable, across scored checks only. 100 when nothing applies. */
  score: number;
};

export type MapReport = {
  /** Null when no entry point had an applicable scored check: an absent figure, not a perfect one. */
  global: number | null;
  /** Entry points with at least one applicable scored check, i.e. those `global` is averaged over. */
  measured: number;
  /** Entry points every scored check reported not-applicable for; excluded from `global`. */
  unmeasured: number;
  /** Suppressions in force: how many entry points carry one, and how many scored checks in total. */
  suppressions: { entries: number; checks: number };
  /** Suppression directives naming no check, per file, so a typo is reported rather than dropped. */
  unknownSuppressions: { fileName: string; ids: string[] }[];
  byFamily: Record<string, { n: number; measured: number; mean: number | null }>;
  sensitiveCohort: { n: number; measured: number; mean: number | null };
  auditGap: { sensitiveMutations: number; withAudit: number };
  /**
   * `request-context` fails 401 of the 412 entry points it applies to, so it is reported as a
   * figure rather than as hundreds of identical list entries, the same treatment `audit-trail`
   * gets. It stays fully in the score: the gap is real and the score is meant to show it.
   */
  contextGap: { applicable: number; naming: number };
  entries: ScoredEntry[];
  parseFailures: string[];
};

export function scoreEntry(ep: EntryPoint): ScoredEntry {
  const { byId: suppressed, unknown } = parseSuppressions(ep.source, ep.fileName);
  const raw = CHECKS.map((c) => c.run(ep));
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
    checks,
    rawChecks: raw,
    suppressed: raw.filter((c) => suppressed.has(c.id)).map((c) => c.id),
    unknownSuppressions: unknown,
    measured: scoredApplicable.length > 0,
    // Capped by the pre-suppression ratio: removing a failing check from both the numerator and
    // the denominator otherwise raises the ratio, which is how 33 became 50 became 100 before this
    // cap existed. See ScoredEntry.measured for why the denominator itself is pre-suppression too.
    score: Math.min(ratio(visible), ratio(scored)),
  };
}

/**
 * Null for an empty group rather than 100. A family nothing was measured in has no score, and
 * rendering the absence as a full green bar said the opposite of what the data said.
 */
const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * `n` is every entry point in the group; `mean` is taken over the measured subset only, so an
 * entry point nothing applied to cannot drag a family's or cohort's figure toward 100. `measured`
 * is reported alongside so a reader can tell a family scoring high because it is clean apart from
 * a family scoring high because most of it was never measured.
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

export function buildReport(eps: EntryPoint[], parseFailures: string[]): MapReport {
  const entries = eps.map(scoreEntry);
  const measuredEntries = entries.filter((e) => e.measured);

  const byFamily: MapReport["byFamily"] = {};
  for (const family of new Set(entries.map((e) => e.family))) {
    byFamily[family] = groupStats(entries.filter((e) => e.family === family));
  }

  const sensitive = entries.filter((e) => e.sensitive);

  // audit-trail is excluded from the score (see checks/index.ts and scoreEntry above), and is
  // reported here as its own architectural figure instead: how many sensitive mutations have an
  // audit record, out of how many. Folding it into the score would tank every sensitive route on a
  // gap that is the same everywhere, and bury the routes that have their own, fixable problems.
  //
  // Both gaps read `rawChecks`, pre-suppression, the same reason `measured` does: suppressing the
  // one request-context or audit-trail finding on an entry must not shrink these denominators and
  // raise the printed percentage, on the same screen as a claim that suppression cannot do that.
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
    unmeasured: entries.length - measuredEntries.length,
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

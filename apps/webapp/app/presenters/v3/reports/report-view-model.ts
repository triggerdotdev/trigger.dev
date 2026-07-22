/**
 * Generic, render-agnostic contract for a Report. Semantic, not a UI tree: numbers +
 * what they mean (codes, severities, units, series), never formatted strings or layout.
 * Every renderer consumes this and owns presentation. Reasons are codes;
 * `report-messages.ts` resolves them -> strings, so phrasing lives in one place.
 *
 * No React/DOM/IO. Report-agnostic — `health` is just one interpreter that emits it.
 */

export type Severity = "ok" | "warn" | "crit";

export type Unit = "ms" | "count" | "ratio" | "perMin";

/** A code resolved to a human string by `report-messages.ts`. */
export type ReasonCode = string;

/** A key into `ReportViewModel.links`, so a recommendation can point at a URL. */
export type LinkKey = string;

export type Delta = {
  dir: "up" | "down" | "flat";
  /** rounded value/normal multiplier; renderer decides whether to print "6×". */
  mult?: number;
};

export type MetricSeries = {
  points: number[];
  /** "estimated" = a proxy (e.g. pending backlog), shown informational-only. */
  kind: "measured" | "estimated";
};

export type Metric = {
  /** CODE, e.g. "start_latency_p95" — messages map -> label "start latency". */
  id: string;
  value: number;
  unit: Unit;
  aggregation?: "p95" | "rate" | "ratio" | "count";
  /** baseline; renderer formats "(normal ~7s)". */
  normal?: number;
  delta?: Delta;
  series?: MetricSeries;
  /** named sub-values for composite metrics (e.g. throughput { done, triggered }). */
  breakdown?: Record<string, number>;
  /** shown on a cause line INSTEAD of "(normal ~x)", e.g. "pinned 40 of last 60 min". */
  annotation?: { code: ReasonCode; value?: number };
  /**
   * Whether `value` is a real measurement. "unknown" = there was no signal, so `value` is a
   * placeholder (e.g. liveness age 0) that a structured consumer must NOT read as a real 0 —
   * the finding's reason carries the "unknown" meaning. Absent = measured (the common case).
   */
  availability?: "measured" | "unknown";
  severity: Severity;
};

export type Recommendation = {
  code: ReasonCode;
  link?: LinkKey;
};

/** A footer line: an action, or the "do nothing" option (carries value). */
export type FooterEntry = {
  code: ReasonCode;
  link?: LinkKey;
  /** a computed fact (e.g. drainMinutes), never invented. */
  value?: number;
};

/** A ruled-out cause + its evidence, e.g. "not your code" (never emitted without evidence). */
export type Exclusion = {
  code: ReasonCode;
  evidence?: Record<string, number>;
};

/**
 * A supporting fact backing the verdict — a measured observation, NOT a ruled-out cause,
 * e.g. "runs are completing at ~820/min". Kept separate from `Exclusion` so the two aren't
 * conflated (an exclusion answers "what it ISN'T"; an observation states "what IS true").
 */
export type Observation = {
  code: ReasonCode;
  evidence?: Record<string, number>;
};

export type Finding = {
  /** "flow" | "execution" | "liveness" | future "infrastructure" | "billing" */
  type: string;
  severity: Severity;
  /** CODE for the state/cause, e.g. "env_limit_saturation" | "healthy". */
  reason: ReasonCode;
  /** CODE for the "read:" line. Built last, may span findings. */
  read?: ReasonCode;
  /** metric ids this finding covers, in causal order when degraded. */
  metricIds: string[];
  /** ONE primary action. */
  recommendation?: Recommendation;
  /** optional parenthetical — same shape as recommendation. */
  hedge?: Recommendation;
  /** contiguous breach window of the driving metric -> "(last 40 min)". */
  anomalyWindow?: { minutes: number; touchesEnd: boolean };
  /**
   * which dimension/key owns the problem, only when share >= threshold. `of` is the
   * denominator label the renderer prints (e.g. "pending" for flow, "failures" for execution)
   * — so it never mislabels a failures share as "% of pending".
   */
  attribution?: { dim: string; key: string; share: number; of: string };
  /** ruled-out causes + evidence — rendered under the `read:` line ("not your code …"). */
  exclusions?: Exclusion[];
  /** supporting facts + evidence — rendered under the `read:` line after the exclusions. */
  observations?: Observation[];
};

export type SummaryStatement = {
  findingType: string;
  severity: Severity;
  /**
   * Normally the statement renders from (findingType, severity). Exceptions carry a reason:
   * stale telemetry marks flow AND execution "unknown" -> "Flow/Execution unknown — data stale";
   * liveness with no signal is "freshness_unknown" -> "data freshness unknown".
   */
  reason?: ReasonCode;
};

export type ReportLink = {
  key: LinkKey;
  label: string;
  url: string;
};

/** a.k.a. ReportDocument — report-agnostic, render-agnostic. */
export type ReportViewModel = {
  /** "health" | "cost" | … */
  title: string;
  /** "prod" */
  scope: string;
  /** "last 1h" */
  period: string;
  /** "vs your 7d normal" */
  baselineLabel?: string;
  /** ISO string — passed in, never read from the clock inside interpret. */
  generatedAt: string;
  /** live window length in minutes — lets the renderer say "of last 60 min". */
  windowMinutes: number;

  summary: {
    severity: Severity;
    statements: SummaryStatement[];
  };
  findings: Finding[];
  metrics: Metric[];
  /** dense structured payload for agents. */
  facts: Record<string, unknown>;
  links: ReportLink[];
  /** dominant finding's action + optional "do nothing" option. Max two entries. */
  footer: FooterEntry[];
};

// ---------------------------------------------------------------------------
// Interpret-side helpers (produce VM fields, no prose, no IO).
// ---------------------------------------------------------------------------

/** Direction + rounded multiplier of `value` against a `normal` baseline. */
export function delta(value: number, normal: number | undefined): Delta {
  if (normal === undefined || !Number.isFinite(normal) || normal === 0) {
    return { dir: "flat" };
  }
  const diff = value - normal;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  return { dir, mult: Math.round(value / normal) };
}

/** Severity of a scalar `x` against ascending warn/crit thresholds. */
export function classifySeverity(x: number, t: { warn: number; crit: number }): Severity {
  if (x >= t.crit) return "crit";
  if (x >= t.warn) return "warn";
  return "ok";
}

const SEVERITY_RANK: Record<Severity, number> = { ok: 0, warn: 1, crit: 2 };

export function maxSeverity(...severities: Severity[]): Severity {
  return severities.reduce<Severity>(
    (acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc),
    "ok"
  );
}

export function isOk(severity: Severity): boolean {
  return severity === "ok";
}

/**
 * Trailing contiguous run of buckets that breach `threshold`, in minutes over
 * `windowMinutes`. Default breach is at/over threshold (ABOVE, e.g. concurrency
 * pinned at the limit); `below: true` counts at/under (BELOW, e.g. running capacity
 * idle under a stall floor). `touchesEnd` = the run reaches the latest bucket
 * ("(last 40 min)" vs mid-window "(14–16h)"). Undefined when nothing breaches.
 */
export function anomalyWindow(
  series: number[],
  threshold: number,
  windowMinutes: number,
  options?: { below?: boolean }
): { minutes: number; touchesEnd: boolean } | undefined {
  if (series.length === 0) return undefined;
  const perBucket = windowMinutes / series.length;
  const breaches = options?.below ? (v: number) => v <= threshold : (v: number) => v >= threshold;

  // longest breaching run + whether any run touches the end.
  let longest = 0;
  let current = 0;
  let touchesEnd = false;
  for (let i = 0; i < series.length; i++) {
    if (breaches(series[i])) {
      current++;
      longest = Math.max(longest, current);
      if (i === series.length - 1) touchesEnd = true;
    } else {
      current = 0;
    }
  }
  if (longest === 0) return undefined;
  // If the run reaches the latest bucket, use the TRAILING length so "(last X min)" is
  // accurate — a longer mid-window run must not inflate it.
  const runBuckets = touchesEnd ? current : longest;
  return { minutes: Math.round(runBuckets * perBucket), touchesEnd };
}

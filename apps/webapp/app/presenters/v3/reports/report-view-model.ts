/**
 * Generic, render-agnostic contract for a Report. Semantic, not a UI tree: numbers +
 * what they mean (codes, severities, units, series), never formatted strings or layout.
 * Every renderer consumes this and owns presentation. Reasons are codes;
 * `report-messages.ts` resolves them -> strings, so phrasing lives in one place.
 *
 * No React/DOM/IO. Report-agnostic — `health` is just one interpreter that emits it.
 *
 * The shapes themselves live in `@trigger.dev/core/v3/schemas` (as zod schemas) because the
 * API serves this view model verbatim under `format=json` and the API clients parse it — one
 * definition, no drift. This module only re-aliases them to the short local names the
 * interpreters and renderers use, and owns the interpret-side helpers below.
 */

import {
  type ReportDelta,
  type ReportExclusion,
  type ReportFinding,
  type ReportFooterEntry,
  type ReportLink as CoreReportLink,
  type ReportLinkKey,
  type ReportMetric,
  type ReportMetricSeries,
  type ReportObservation,
  type ReportReasonCode,
  type ReportRecommendation,
  type ReportSeverity,
  type ReportSummaryStatement,
  type ReportUnit,
  type ReportViewModel as CoreReportViewModel,
} from "@trigger.dev/core/v3/schemas";

export type Severity = ReportSeverity;
export type Unit = ReportUnit;
/** A code resolved to a human string by `report-messages.ts`. */
export type ReasonCode = ReportReasonCode;
/** A key into `ReportViewModel.links`, so a recommendation can point at a URL. */
export type LinkKey = ReportLinkKey;
export type Delta = ReportDelta;
export type MetricSeries = ReportMetricSeries;
export type Metric = ReportMetric;
export type Recommendation = ReportRecommendation;
export type FooterEntry = ReportFooterEntry;
export type Exclusion = ReportExclusion;
export type Observation = ReportObservation;
export type Finding = ReportFinding;
export type SummaryStatement = ReportSummaryStatement;
export type ReportLink = CoreReportLink;
/** a.k.a. ReportDocument — report-agnostic, render-agnostic. */
export type ReportViewModel = CoreReportViewModel;

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
 *
 * `bucketMinutes` + `timestampsMs` make the duration GAP-AWARE: each bucket then counts for its
 * real cadence (not window/received, which inflates a sparse series), and a missing bucket breaks
 * the contiguous run instead of being silently bridged. Without them the series is assumed
 * gap-free and evenly spread over the window.
 */
export function anomalyWindow(
  series: number[],
  threshold: number,
  windowMinutes: number,
  options?: { below?: boolean; bucketMinutes?: number; timestampsMs?: number[] }
): { minutes: number; touchesEnd: boolean } | undefined {
  if (series.length === 0) return undefined;
  const bucketMinutes = options?.bucketMinutes;
  const perBucket =
    bucketMinutes !== undefined && bucketMinutes > 0
      ? bucketMinutes
      : windowMinutes / series.length;
  const breaches = options?.below ? (v: number) => v <= threshold : (v: number) => v >= threshold;
  // Buckets are adjacent in TIME when their timestamps differ by ~one cadence; anything larger
  // is a gap (a dropped bucket), which must not extend the run.
  const timestamps = options?.timestampsMs;
  const maxGapMs =
    timestamps && timestamps.length === series.length && bucketMinutes
      ? bucketMinutes * 60_000 * 1.5
      : undefined;
  const adjacent = (i: number) =>
    maxGapMs === undefined || i === 0 || timestamps![i] - timestamps![i - 1] <= maxGapMs;

  // longest breaching run + whether any run touches the end.
  let longest = 0;
  let current = 0;
  let touchesEnd = false;
  for (let i = 0; i < series.length; i++) {
    if (breaches(series[i])) {
      current = adjacent(i) ? current + 1 : 1;
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

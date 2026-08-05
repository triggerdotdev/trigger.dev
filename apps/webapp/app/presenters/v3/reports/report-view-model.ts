/**
 * Render-agnostic contract for a report: numbers plus what they mean (codes, severities, units,
 * series), never formatted strings or layout. Reasons are codes, and `report-messages.ts` resolves
 * them to strings so phrasing lives in one place.
 *
 * The shapes live in `@trigger.dev/core/v3/schemas` as zod schemas, because the API serves this view
 * model verbatim under `format=json` and the clients parse it. This module re-aliases them to short
 * local names and owns the interpret-side helpers below.
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
export type ReportViewModel = CoreReportViewModel;

/** Direction and rounded multiplier of `value` against a `normal` baseline. */
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
 * Trailing contiguous run of buckets that breach `threshold`, in minutes over `windowMinutes`. By
 * default a breach is at or over the threshold; `below: true` counts at or under it. `touchesEnd`
 * means the run reaches the latest bucket. Undefined when nothing breaches.
 *
 * `bucketMinutes` and `timestampsMs` make the duration gap-aware: each bucket counts for its real
 * cadence rather than window over received, which inflates a sparse series, and a missing bucket
 * breaks the run instead of being silently bridged. Without them the series is assumed gap-free.
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
  // Buckets are adjacent in time when their timestamps differ by about one cadence. Anything larger
  // is a dropped bucket, which must not extend the run.
  const timestamps = options?.timestampsMs;
  const maxGapMs =
    timestamps && timestamps.length === series.length && bucketMinutes
      ? bucketMinutes * 60_000 * 1.5
      : undefined;
  const adjacent = (i: number) =>
    maxGapMs === undefined || i === 0 || timestamps![i] - timestamps![i - 1] <= maxGapMs;

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
  // When the run reaches the latest bucket, use the trailing length so a longer mid-window run
  // can't inflate it.
  const runBuckets = touchesEnd ? current : longest;
  return { minutes: Math.round(runBuckets * perBucket), touchesEnd };
}

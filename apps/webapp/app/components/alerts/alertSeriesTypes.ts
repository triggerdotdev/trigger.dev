export type MetricSeriesPoint = { bucket: number; value: number | null; key?: string };

export type LifecycleTimelineEvent = {
  type: "raised" | "recovered" | "resolved" | "stopped" | "expired";
  at: Date;
};

export type ScopeType = "task" | "queue" | "fingerprint" | "queuePattern" | "all" | "errorGroup";

export function pickThresholdSeries(
  seriesMap: Map<string, MetricSeriesPoint[]>,
  scopeType: ScopeType
):
  | { series: MetricSeriesPoint[]; multi: false }
  | { seriesMap: Map<string, MetricSeriesPoint[]>; multi: true } {
  const isSingle =
    scopeType === "task" ||
    scopeType === "queue" ||
    scopeType === "fingerprint" ||
    scopeType === "errorGroup" ||
    scopeType === "all";
  if (isSingle) {
    return { series: seriesMap.get("__agg__") ?? [], multi: false };
  }
  return { seriesMap, multi: true };
}

export type QuietWindowBounds = { x1: number; x2: number } | null;

export function quietWindowBounds(
  series: MetricSeriesPoint[],
  quietWindowSec: number | undefined
): QuietWindowBounds {
  if (!quietWindowSec || series.length === 0) return null;
  const last = series[series.length - 1]!;
  const x2 = last.bucket;
  const x1 = Math.max(x2 - quietWindowSec * 1000, series[0]!.bucket);
  return { x1, x2 };
}

export type HealthBandRow = {
  bucket: number;
  degraded: 1 | null;
  healthy: 1 | null;
  unknown: 1 | null;
};

type HealthFinding = { type: string; severity: string };

export const HEALTH_BUCKET_MS = 4 * 60 * 60 * 1000;
const HEALTH_BAND_DAYS = 7;

function statusFromFindings(facts: Record<string, unknown>): "degraded" | "healthy" {
  const findings = Array.isArray(facts?.findings) ? (facts.findings as HealthFinding[]) : [];
  return findings.some((f) => f.severity === "warn" || f.severity === "crit")
    ? "degraded"
    : "healthy";
}

export function buildHealthBands(
  events: Array<{ at: Date; facts: Record<string, unknown> }>,
  now = Date.now(),
  startMs = now - HEALTH_BAND_DAYS * 24 * 60 * 60 * 1000,
  minBucketMs = HEALTH_BUCKET_MS,
  healthySince?: number
): HealthBandRow[] {
  const windowMs = now - startMs;
  const maxBuckets = (HEALTH_BAND_DAYS * 24 * 60 * 60 * 1000) / HEALTH_BUCKET_MS;
  const bucketMs = Math.max(minBucketMs, Math.ceil(windowMs / maxBuckets));
  const totalBuckets = Math.ceil(windowMs / bucketMs);

  const allSorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());

  let seedStatus: "degraded" | "healthy" | "unknown" = "unknown";
  for (const ev of allSorted) {
    if (ev.at.getTime() >= startMs) break;
    seedStatus = statusFromFindings(ev.facts);
  }

  const sorted = allSorted.filter((e) => e.at.getTime() >= startMs);

  function statusAt(atMs: number): "degraded" | "healthy" | "unknown" {
    let last: "degraded" | "healthy" | "unknown" =
      seedStatus === "unknown" && healthySince !== undefined && atMs > healthySince
        ? "healthy"
        : seedStatus;
    for (const ev of sorted) {
      if (ev.at.getTime() > atMs) break;
      last = statusFromFindings(ev.facts);
    }
    return last;
  }

  const rows: HealthBandRow[] = [];
  for (let i = 0; i < totalBuckets; i++) {
    const bucketStart = startMs + i * bucketMs;
    const endStatus = statusAt(bucketStart + bucketMs);
    // A degraded stretch shorter than a bucket still marks the bucket.
    const status = sorted.some(
      (ev) =>
        ev.at.getTime() > bucketStart &&
        ev.at.getTime() <= bucketStart + bucketMs &&
        statusFromFindings(ev.facts) === "degraded"
    )
      ? "degraded"
      : endStatus;
    rows.push({
      bucket: bucketStart,
      degraded: status === "degraded" ? 1 : null,
      healthy: status === "healthy" ? 1 : null,
      unknown: status === "unknown" ? 1 : null,
    });
  }
  return rows;
}

export const CLEARING_EVENTS = new Set(["recovered", "resolved", "stopped", "expired"]);

export function healthEventsForBands<T extends { type: string; at: Date; facts: unknown }>(
  events: T[]
): Array<{ at: Date; facts: Record<string, unknown> }> {
  return events.flatMap((event) => {
    const facts = (event.facts ?? {}) as Record<string, unknown>;
    if (Array.isArray(facts.findings)) return [{ at: event.at, facts }];
    if (event.type === "raised") {
      return [{ at: event.at, facts: { findings: [{ type: "raised", severity: "warn" }] } }];
    }
    if (CLEARING_EVENTS.has(event.type)) return [{ at: event.at, facts: { findings: [] } }];
    return [];
  });
}

const LIFECYCLE_TYPES = new Set(["raised", "recovered", "resolved", "stopped", "expired"]);

export function mapEventsToTimeline(
  events: Array<{ type: string; at: Date }>
): LifecycleTimelineEvent[] {
  return events
    .filter((e) => LIFECYCLE_TYPES.has(e.type))
    .map((e) => ({ type: e.type as LifecycleTimelineEvent["type"], at: e.at }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

export type HealthQuerySeries = {
  key: string;
  label: string;
  threshold: number;
  points: MetricSeriesPoint[];
};

function splitTopLevelOr(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^\sOR\s/i.test(expression.slice(i, i + 4))) {
      parts.push(expression.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((p) => p.trim());
}

function topLevel(expression: string): string {
  let depth = 0;
  let out = "";
  for (const ch of expression) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

export type HealthQueryTerm = {
  template: string;
  paramKey: string;
  groupBy: string | null;
  lastRun?: boolean;
};

export function healthQueryTerms(template: string): { lines: HealthQueryTerm[] } {
  const match = template.match(/^SELECT\s+(.*?)\s+FROM\s+(.*)$/is);
  if (!match) return { lines: [] };
  const rest = match[2]!;
  const groupBy = rest.match(/\s+GROUP\s+BY\s+(\w+)\s*$/i);
  const from = groupBy ? rest.slice(0, groupBy.index) : rest;
  const lines: HealthQueryTerm[] = [];
  for (const term of splitTopLevelOr(match[1]!)) {
    const cmp = term.match(/^(.+?)\s*>\s*\{\{p\.(\w+)\}\}$/s);
    const lhs = cmp?.[1]?.trim();
    const lastRun = lhs?.match(/^dateDiff\('second',\s*max\((\w+)\),\s*now\(\)\)$/i);
    if (lastRun) {
      lines.push({
        template: `SELECT toUnixTimestamp(max(${lastRun[1]})) FROM ${from}`,
        paramKey: cmp![2]!,
        groupBy: null,
        lastRun: true,
      });
      continue;
    }
    // Sums grow with bucket width and now()-relative ages drift, so neither plots per bucket.
    if (
      !lhs ||
      /[<>=]|\bAND\b|\bOR\b/i.test(topLevel(lhs)) ||
      /^sum\(/i.test(lhs) ||
      /\bnow\(\)/i.test(lhs)
    ) {
      continue;
    }
    lines.push({
      template: `SELECT ${lhs} FROM ${from}`,
      paramKey: cmp![2]!,
      groupBy: groupBy?.[1] ?? null,
    });
  }
  return { lines };
}

export function percentOfThreshold(
  points: MetricSeriesPoint[],
  threshold: number
): MetricSeriesPoint[] {
  return points.map((p) => ({
    ...p,
    value: p.value === null ? null : (p.value / threshold) * 100,
  }));
}

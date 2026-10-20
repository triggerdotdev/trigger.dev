import {
  compileTemplate as compileTemplateWithCtx,
  displayStatus,
  type AlertCapability,
  type Condition,
  type AlertLifecycle,
  type AlertParams,
} from "@internal/alert-contracts";
import {
  clickhouseDateTimeLiteral,
  compileTemplate,
  DEFAULT_QUERY_EVALUATOR_CONFIG,
  resolveEffectiveParams,
  scopeWhere,
  type QueryRowRunner,
} from "./evaluators/queryEvaluator.server";
import type { MetricSeriesPoint } from "~/components/alerts/alertSeriesTypes";
import { getLimit } from "~/services/platform.v3.server";

export type AlertSeriesBucket = { date: Date; count: number };

const MAX_BUCKETS = 48;
const DEFAULT_METRIC_WINDOW_HOURS = 24;
const METRIC_CACHE_TTL_MS = 60_000;
const METRIC_CACHE_MAX_SIZE = 500;
const MAX_KEYED_SERIES = 5;

export function planHealthChartEvents<T>(params: {
  seed: T | undefined;
  events: T[];
  healthySince: number | undefined;
  cap: number;
}): { events: T[]; healthySince: number | undefined } {
  if (params.events.length > params.cap) {
    return { events: params.events.slice(1), healthySince: undefined };
  }
  return {
    events: params.seed ? [params.seed, ...params.events] : params.events,
    healthySince: params.healthySince,
  };
}

export type AlertSeriesWindow = { since: Date; until: Date };

export function alertLifetimeWindow(
  alert: {
    lifecycle: AlertLifecycle;
    createdAt: Date;
    resolvedAt: Date | null;
    stoppedAt: Date | null;
    expiresAt: Date | null;
  },
  now = new Date()
): AlertSeriesWindow | undefined {
  const status = displayStatus(alert.lifecycle, "clear");
  if (status.status !== "inactive") return undefined;
  const endedAt =
    status.reason === "completed"
      ? alert.resolvedAt
      : status.reason === "expired"
        ? alert.expiresAt
        : alert.stoppedAt;
  const until = new Date(Math.min((endedAt ?? now).getTime(), now.getTime()));
  const since = alert.createdAt < until ? alert.createdAt : new Date(until.getTime() - 3600 * 1000);
  return { since, until };
}

export function windowBucketSeconds(window: AlertSeriesWindow, minBucketSeconds: number): number {
  const spanSec = (window.until.getTime() - window.since.getTime()) / 1000;
  const steps = Math.ceil(spanSec / (MAX_BUCKETS - 1) / minBucketSeconds);
  return Math.max(1, steps) * minBucketSeconds;
}

const TABLE_TIME_COLUMN: Record<string, string> = {
  concurrency_metrics: "bucket_start",
  runs: "triggered_at",
};

export type EvaluationWindow = { seconds: number; operator: ">" | "<" };

export function evaluationWindow(
  condition: Condition | undefined,
  params: AlertParams,
  minCadenceSec: number
): EvaluationWindow | undefined {
  if (condition?.kind === "threshold") {
    return { seconds: condition.windowSec, operator: condition.operator };
  }
  if (condition?.kind === "state") {
    return { seconds: params.windowSec ?? minCadenceSec, operator: ">" };
  }
  return undefined;
}

export function tiledBucketSeconds(bucketSeconds: number, evalWindow?: EvaluationWindow): number {
  if (!evalWindow || bucketSeconds <= evalWindow.seconds) return bucketSeconds;
  return Math.ceil(bucketSeconds / evalWindow.seconds) * evalWindow.seconds;
}

function toBucket(col: string, seconds: number): string {
  return `toStartOfInterval(${col}, toIntervalSecond(${seconds}))`;
}

function extractWhereClause(sql: string): string {
  const where = /\bWHERE\s+/i.exec(sql);
  if (!where) return "1 = 1";

  const start = where.index + where[0].length;
  let quote: string | null = null;
  let end = sql.length;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (/^\s+GROUP\s+BY\b/i.test(sql.slice(i, i + 12)) && /\s/.test(ch)) {
      end = i;
      break;
    }
  }
  return sql.slice(start, end).trim() || "1 = 1";
}

export function buildBucketedQuery(params: {
  template: string;
  table: string;
  scope: string;
  bucketSeconds: number;
  maxBuckets: number;
  grouped: boolean;
  templateParams?: Record<string, number>;
  evalWindow?: EvaluationWindow;
  partitionBy?: string;
  minVolume?: number;
}): string {
  const timeCol = TABLE_TIME_COLUMN[params.table] ?? "created_at";
  const compiled = compileTemplate(params.template, {
    scope: params.scope,
    params: params.templateParams,
  });

  const fromMatch = compiled.match(/\bFROM\s+(\S+)/i);
  const tableName = fromMatch ? fromMatch[1] : params.table;
  const whereClause = extractWhereClause(compiled);

  const selectMatch = compiled.match(
    /^SELECT\s+(?:(?:queue|task_identifier)\s*,\s*)?(.*?)\s+FROM\b/is
  );
  const aggregate = selectMatch ? selectMatch[1]!.trim() : "count()";

  const bucketSeconds = tiledBucketSeconds(params.bucketSeconds, params.evalWindow);
  const bucket = toBucket(timeCol, bucketSeconds);
  const sub =
    params.evalWindow && bucketSeconds > params.evalWindow.seconds ? params.evalWindow : undefined;

  const bucketed = (where: string, keyCol: string | null, limit: number) => {
    const keySelect = keyCol ? `${keyCol} AS key, ` : "";
    const keyGroup = keyCol ? ", key" : "";
    if (!sub && !params.partitionBy) {
      return [
        `SELECT ${bucket} AS bucket, ${keySelect}${aggregate} AS value`,
        `FROM ${tableName}`,
        `WHERE ${where}`,
        `GROUP BY bucket${keyGroup}`,
        `ORDER BY bucket DESC`,
        `LIMIT ${limit}`,
      ].join(" ");
    }
    const partition = params.partitionBy ? `, ${params.partitionBy}` : "";
    const inner = [
      `SELECT ${sub ? toBucket(timeCol, sub.seconds) : bucket} AS sub_bucket, ${keySelect}${aggregate} AS sub_value`,
      `FROM ${tableName}`,
      `WHERE ${where}`,
      `GROUP BY sub_bucket${keyGroup}${partition}`,
      ...(sub && params.minVolume ? [`HAVING count() >= ${params.minVolume}`] : []),
    ].join(" ");
    const worst =
      params.evalWindow?.operator === "<"
        ? "min(sub_value) AS value, count() AS windows"
        : "max(sub_value) AS value";
    return [
      `SELECT ${toBucket("sub_bucket", bucketSeconds)} AS bucket, ${keyCol ? "key, " : ""}${worst}`,
      `FROM (${inner})`,
      `GROUP BY bucket${keyGroup}`,
      `ORDER BY bucket DESC`,
      `LIMIT ${limit}`,
    ].join(" ");
  };

  const groupCol = params.grouped
    ? compiled.match(/\bGROUP\s+BY\s+(queue|task_identifier)\b/i)
    : null;
  if (!groupCol) return bucketed(whereClause, null, params.maxBuckets);

  const keyCol = groupCol[1]!;
  const topKeys = [
    `SELECT ${keyCol} AS _k FROM ${tableName}`,
    `WHERE ${whereClause}`,
    `GROUP BY _k ORDER BY ${aggregate} DESC`,
    `LIMIT ${MAX_KEYED_SERIES}`,
  ].join(" ");
  return bucketed(
    `${whereClause} AND ${keyCol} IN (${topKeys})`,
    keyCol,
    params.maxBuckets * MAX_KEYED_SERIES
  );
}

function buildSeriesTemplateQuery(params: {
  template: string;
  scope: string;
  checkpoint: Date;
  until: Date;
  bucketSeconds: number;
  maxBuckets: number;
  templateParams?: Record<string, number>;
}): string {
  const compiled = compileTemplateWithCtx(params.template, params.scope, params.templateParams, {
    checkpoint: clickhouseDateTimeLiteral(params.checkpoint),
    until: clickhouseDateTimeLiteral(params.until),
  });
  const match = compiled.match(
    /^SELECT\s+(.+?)\s+AS\s+bucket\s*,\s*(.+?)\s+AS\s+\w+\s+FROM\b(.*)$/is
  );
  if (!match) throw new Error("series template must select a bucket and a value");
  const [, bucketExpr, valueExpr, rest] = match;
  const timeCol = bucketExpr!.match(/^toStartOf\w+\((.+)\)$/i)?.[1] ?? bucketExpr!;
  const body = rest!.replace(/\s+ORDER\s+BY\s+bucket\s*$/i, "");
  return [
    `SELECT ${toBucket(timeCol, params.bucketSeconds)} AS bucket, ${valueExpr} AS value`,
    `FROM${body}`,
    `ORDER BY bucket DESC`,
    `LIMIT ${params.maxBuckets}`,
  ].join(" ");
}

function isGroupedScope(scope: AlertParams["scope"]): boolean {
  return scope.type === "queuePattern" || scope.type === "all";
}

export function fillBuckets(
  sparse: { bucket: Date; count: number }[],
  since: Date,
  now: Date,
  bucketSeconds: number,
  maxBuckets = MAX_BUCKETS
): AlertSeriesBucket[] {
  const bucketMs = bucketSeconds * 1000;
  const startMs = since.getTime();
  const endMs = now.getTime();
  const totalBuckets = Math.min(Math.ceil((endMs - startMs) / bucketMs), maxBuckets);

  const byTime = new Map<number, number>();
  for (const row of sparse) {
    const aligned = Math.floor((row.bucket.getTime() - startMs) / bucketMs);
    byTime.set(aligned, (byTime.get(aligned) ?? 0) + row.count);
  }

  const result: AlertSeriesBucket[] = [];
  for (let i = 0; i < totalBuckets; i++) {
    result.push({
      date: new Date(startMs + i * bucketMs),
      count: byTime.get(i) ?? 0,
    });
  }
  return result;
}

export function fillMetricBuckets(
  sparse: MetricSeriesPoint[],
  sinceMs: number,
  nowMs: number,
  bucketSeconds: number,
  gapValue: 0 | null = 0,
  includeNowBucket = hasNowBucket(sparse, nowMs, bucketSeconds),
  maxBuckets = MAX_BUCKETS
): MetricSeriesPoint[] {
  const bucketMs = bucketSeconds * 1000;
  const alignedNow = Math.floor(nowMs / bucketMs) * bucketMs;
  const alignedSince = Math.floor(sinceMs / bucketMs) * bucketMs;
  const endMs = includeNowBucket ? alignedNow : alignedNow - bucketMs;
  const rawBuckets = Math.floor((endMs - alignedSince) / bucketMs) + 1;
  const totalBuckets = Math.max(0, Math.min(rawBuckets, maxBuckets));
  const originMs = endMs - (totalBuckets - 1) * bucketMs;

  const byIndex = new Map<number, number | null>();
  for (const row of sparse) {
    const idx = Math.floor((row.bucket - originMs) / bucketMs);
    if (idx >= 0 && idx < totalBuckets) {
      byIndex.set(idx, row.value);
    }
  }

  const result: MetricSeriesPoint[] = [];
  for (let i = 0; i < totalBuckets; i++) {
    result.push({
      bucket: originMs + i * bucketMs,
      value: byIndex.get(i) ?? gapValue,
    });
  }
  return result;
}

function hasNowBucket(points: MetricSeriesPoint[], nowMs: number, bucketSeconds: number): boolean {
  const bucketMs = bucketSeconds * 1000;
  const alignedNow = Math.floor(nowMs / bucketMs) * bucketMs;
  return points.some((p) => p.bucket >= alignedNow && p.value !== null);
}

function gapValueFor(capability: AlertCapability): 0 | null {
  return capability.freshness === "counter" && capability.unit === "count" ? 0 : null;
}

type CacheEntry = { data: Map<string, MetricSeriesPoint[]>; expiresAt: number };
const metricCache = new Map<string, CacheEntry>();

function evictOldest(): void {
  if (metricCache.size <= METRIC_CACHE_MAX_SIZE) return;
  let oldestKey: string | undefined;
  let oldestExpiry = Infinity;
  for (const [key, entry] of metricCache) {
    if (entry.expiresAt < oldestExpiry) {
      oldestExpiry = entry.expiresAt;
      oldestKey = key;
    }
  }
  if (oldestKey) metricCache.delete(oldestKey);
}

function getCachedMetricSeries(alertId: string): Map<string, MetricSeriesPoint[]> | undefined {
  const entry = metricCache.get(alertId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    metricCache.delete(alertId);
    return undefined;
  }
  return entry.data;
}

function setCachedMetricSeries(alertId: string, data: Map<string, MetricSeriesPoint[]>): void {
  metricCache.set(alertId, { data, expiresAt: Date.now() + METRIC_CACHE_TTL_MS });
  evictOldest();
}

export function clearMetricCache(): void {
  metricCache.clear();
}

export function metricCacheSize(): number {
  return metricCache.size;
}

export interface MetricSeriesParams {
  alertId: string;
  capability: AlertCapability;
  params: AlertParams;
  condition?: Condition;
  organizationId: string;
  projectId: string;
  windowHours?: number;
  window?: AlertSeriesWindow;
  maxBuckets?: number;
  bucketSeconds?: number;
  failureRateMinVolume?: number;
  includeNowBucket?: boolean;
}

function hasValue(row: Record<string, unknown>): boolean {
  return row.value !== null && row.value !== undefined;
}

export async function getMetricSeries(
  input: MetricSeriesParams,
  runner: QueryRowRunner
): Promise<Map<string, MetricSeriesPoint[]>> {
  if (input.capability.binding.type !== "query") {
    return new Map();
  }

  const maxBuckets = input.maxBuckets ?? MAX_BUCKETS;
  const gapValue = gapValueFor(input.capability);
  const conditionWindow = evaluationWindow(
    input.condition,
    input.params,
    input.capability.binding.minCadenceSec
  );
  const evalWindow =
    conditionWindow?.operator === "<" && gapValue !== 0 ? undefined : conditionWindow;
  const baseKey = input.window
    ? `${input.alertId}:${input.window.since.getTime()}:${input.window.until.getTime()}`
    : maxBuckets === MAX_BUCKETS
      ? input.alertId
      : `${input.alertId}:max${maxBuckets}`;
  const windowKey = evalWindow
    ? `${baseKey}:w${evalWindow.seconds}${evalWindow.operator}`
    : baseKey;
  const cacheKey = input.bucketSeconds ? `${windowKey}:b${input.bucketSeconds}` : windowKey;
  const cached = getCachedMetricSeries(cacheKey);
  if (cached) return cached;

  const windowHours = input.windowHours ?? DEFAULT_METRIC_WINDOW_HOURS;
  const minCadenceSec = input.capability.binding.minCadenceSec;
  const bucketSeconds = tiledBucketSeconds(
    input.bucketSeconds ??
      (input.window
        ? windowBucketSeconds(input.window, minCadenceSec)
        : minCadenceSec * Math.ceil(MAX_BUCKETS / maxBuckets)),
    evalWindow
  );
  const now = input.window ? input.window.until.getTime() : Date.now();
  const spanMs = Math.min(windowHours * 3600 * 1000, maxBuckets * bucketSeconds * 1000);
  const requestedSinceMs = input.window ? input.window.since.getTime() : now - spanMs;
  const sinceMs = input.capability.binding.fullRetention
    ? Math.max(
        requestedSinceMs,
        Date.now() - (await getLimit(input.organizationId, "queryPeriodDays", 30)) * 86_400_000
      )
    : requestedSinceMs;
  const template = input.capability.binding.template;
  const table = input.capability.binding.table;
  if (!template || !table) return new Map();
  const seriesTemplate = input.capability.binding.seriesTemplate;
  const templateHasGroupBy = /\bGROUP\s+BY\s+(queue|task_identifier)\b/i.test(template);
  const grouped = !seriesTemplate && isGroupedScope(input.params.scope) && templateHasGroupBy;
  const minVolume =
    input.capability.key === "runs.failure_rate"
      ? (input.failureRateMinVolume ?? DEFAULT_QUERY_EVALUATOR_CONFIG.failureRateMinVolume)
      : undefined;

  const templateParams = resolveEffectiveParams(
    input.condition?.kind === "state" ? input.condition : undefined,
    input.capability.binding.params
  );

  const query = seriesTemplate
    ? buildSeriesTemplateQuery({
        template: seriesTemplate,
        scope: scopeWhere(input.params),
        checkpoint: new Date(sinceMs),
        until: new Date(now),
        bucketSeconds,
        maxBuckets,
        templateParams,
      })
    : buildBucketedQuery({
        templateParams,
        template,
        table,
        scope: scopeWhere(input.params),
        bucketSeconds,
        maxBuckets,
        grouped,
        evalWindow,
        minVolume,
      });

  const fillEmpty =
    evalWindow?.operator === "<" && bucketSeconds > evalWindow.seconds ? evalWindow.seconds : 0;
  const windowMs = fillEmpty * 1000;
  const fromMs = fillEmpty ? Math.ceil(sinceMs / windowMs) * windowMs : sinceMs;
  const toMs = fillEmpty ? Math.floor(now / windowMs) * windowMs : now;
  const range = {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
  const withEmptyWindows = (result: Record<string, unknown>[]) =>
    fillEmpty
      ? result.map((r) => {
          const start = new Date(r.bucket as string).getTime();
          const span = Math.min(start + bucketSeconds * 1000, toMs) - Math.max(start, fromMs);
          return Number(r.windows) < Math.floor(span / windowMs) ? { ...r, value: 0 } : r;
        })
      : result;

  const rows = await runner(
    query,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.params.environmentId,
    },
    range,
    { fullRetention: input.capability.binding.fullRetention }
  ).then((result) => withEmptyWindows(result.filter(hasValue)));

  const seriesByKey = new Map<string, MetricSeriesPoint[]>();

  if (grouped) {
    const aggQuery = buildBucketedQuery({
      templateParams,
      template: template,
      table: table,
      scope: scopeWhere(input.params),
      bucketSeconds,
      maxBuckets,
      grouped: false,
      evalWindow,
      minVolume,
    });
    const aggRows = await runner(
      aggQuery,
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.params.environmentId,
      },
      range
    ).then((result) => withEmptyWindows(result.filter(hasValue)));
    const toPoint = (r: Record<string, unknown>) => ({
      bucket: new Date(r.bucket as string).getTime(),
      value: Number(r.value) || 0,
    });
    const aggPoints = aggRows.map(toPoint);
    const includeNow = hasNowBucket([...rows.map(toPoint), ...aggPoints], now, bucketSeconds);
    const fill = (points: MetricSeriesPoint[]) =>
      fillMetricBuckets(points, sinceMs, now, bucketSeconds, gapValue, includeNow, maxBuckets);

    const keyTotals = new Map<string, number>();
    for (const row of rows) {
      const key = typeof row.key === "string" ? row.key : "__agg__";
      const value = Number(row.value) || 0;
      keyTotals.set(key, (keyTotals.get(key) ?? 0) + value);
    }
    const topKeys = Array.from(keyTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEYED_SERIES)
      .map(([k]) => k);
    const topSet = new Set(topKeys);

    for (const key of topKeys) {
      const points = rows.filter((r) => r.key === key).map((r) => ({ ...toPoint(r), key }));
      seriesByKey.set(key, fill(points));
    }

    const merged = new Map<number, number>();
    for (const row of rows) {
      const key = typeof row.key === "string" ? row.key : "__agg__";
      if (!topSet.has(key)) {
        const p = toPoint(row);
        merged.set(p.bucket, (merged.get(p.bucket) ?? 0) + p.value);
      }
    }
    if (merged.size > 0) {
      seriesByKey.set(
        "__other__",
        fill(Array.from(merged, ([bucket, value]) => ({ bucket, value })))
      );
    }

    seriesByKey.set("__agg__", aggPoints.length === 0 && gapValue !== 0 ? [] : fill(aggPoints));
  } else {
    const points = rows.map((r) => ({
      bucket: new Date(r.bucket as string).getTime(),
      value: Number(r.value) || 0,
    }));
    seriesByKey.set(
      "__agg__",
      points.length === 0 && gapValue !== 0
        ? []
        : fillMetricBuckets(
            points,
            sinceMs,
            now,
            bucketSeconds,
            gapValue,
            input.includeNowBucket,
            maxBuckets
          )
    );
  }

  setCachedMetricSeries(cacheKey, seriesByKey);
  return seriesByKey;
}

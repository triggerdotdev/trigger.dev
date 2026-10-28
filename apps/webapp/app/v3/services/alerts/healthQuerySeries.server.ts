import { parseClickhouseDateTime } from "./clickhouseDateTime";
import {
  alertParamsSchema,
  conditionSchema,
  getCapability,
  selectedComponents,
  type AlertCapability,
  type AlertParams,
  type Condition,
} from "@internal/alert-contracts";
import { isLimitComponent, type LimitTileSeries } from "~/components/alerts/limitTiles";
import {
  healthQueryTerms,
  percentOfThreshold,
  type HealthQuerySeries,
  type HealthQueryTerm,
  type MetricSeriesPoint,
} from "~/components/alerts/alertSeriesTypes";
import { logger } from "~/services/logger.server";
import { isQueryConcurrencyRejection } from "~/services/queryService.server";
import {
  buildBucketedQuery,
  evaluationWindow,
  fillMetricBuckets,
  getMetricSeries,
  tiledBucketSeconds,
  windowBucketSeconds,
  type AlertSeriesWindow,
  type EvaluationWindow,
} from "./alertSeries.server";
import {
  clickhouseDateTimeLiteral,
  compileTemplate,
  resolveEffectiveParams,
  scopeWhere,
  type QueryRowRunner,
} from "./evaluators/queryEvaluator.server";

type HealthQueryInput = {
  alertId: string;
  capability: AlertCapability;
  params: unknown;
  condition: unknown;
  organizationId: string;
  projectId: string;
  window: AlertSeriesWindow;
};

const RETRY_BACKOFF_MS = 400;
const PRE_WINDOW_LOOKBACK_MS = 90 * 86400_000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isQueryConcurrencyRejection(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    return fn();
  }
}

export function retryOnConcurrency(runner: QueryRowRunner): QueryRowRunner {
  return (query, context, range, opts) => withRetry(() => runner(query, context, range, opts));
}

export type HealthQueryLines = { series: HealthQuerySeries[] };

export function worstGroupQuery(
  term: HealthQueryTerm & { groupBy: string },
  table: string,
  params: AlertParams,
  templateParams: Record<string, number>,
  bucketSeconds: number,
  maxBuckets: number,
  evalWindow?: EvaluationWindow
): string {
  return buildBucketedQuery({
    template: term.template,
    table,
    scope: scopeWhere(params),
    bucketSeconds,
    maxBuckets,
    grouped: false,
    templateParams,
    evalWindow,
    partitionBy: term.groupBy,
  });
}

export async function getHealthQuerySeries(
  input: HealthQueryInput,
  runner: QueryRowRunner
): Promise<HealthQueryLines> {
  let params: AlertParams;
  let condition;
  try {
    params = alertParamsSchema.parse(input.params);
    const parsed = conditionSchema.parse(input.condition);
    condition = parsed.kind === "state" ? parsed : undefined;
  } catch {
    return { series: [] };
  }

  const keys = input.capability.binding.compositeOf
    ? selectedComponents(input.capability, condition)
    : [input.capability.key];
  const capabilities = keys.flatMap((key) => {
    const capability = getCapability(key);
    const binding = capability?.binding;
    return capability &&
      !isLimitComponent(key) &&
      binding?.type === "query" &&
      binding.template &&
      binding.table
      ? [capability]
      : [];
  });
  if (capabilities.length === 0) return { series: [] };
  const cadences = capabilities.map((c) => c.binding.minCadenceSec);
  const maxWindowSec = Math.max(
    ...capabilities.map(
      (c) => evaluationWindow(condition, params, c.binding.minCadenceSec)?.seconds ?? 0
    )
  );
  const bucketSeconds = tiledBucketSeconds(
    windowBucketSeconds(input.window, Math.max(...cadences)),
    maxWindowSec > 0 ? { seconds: maxWindowSec, operator: ">" } : undefined
  );

  const series: HealthQuerySeries[] = [];
  for (const capability of capabilities) {
    const { template, table } = capability?.binding ?? {};
    if (!capability || capability.binding.type !== "query" || !template || !table) continue;
    const templateParams = resolveEffectiveParams(condition, capability.binding.params);
    const terms = healthQueryTerms(template);

    for (const term of terms.lines) {
      const param = capability.binding.params?.find((p) => p.key === term.paramKey);
      const threshold = templateParams[term.paramKey];
      if (!param || threshold === undefined || !(threshold > 0)) continue;
      try {
        const priorRunSec = term.lastRun
          ? await withRetry(() => priorRunSeconds(term, params, templateParams, input, runner))
          : undefined;
        const points = await withRetry(() =>
          term.groupBy
            ? worstGroupSeries(
                { ...term, groupBy: term.groupBy },
                table,
                params,
                templateParams,
                evaluationWindow(condition, params, capability.binding.minCadenceSec),
                bucketSeconds,
                input,
                runner
              )
            : getMetricSeries(
                {
                  ...input,
                  alertId: `${input.alertId}:${term.paramKey}`,
                  capability: {
                    ...capability,
                    binding: { ...capability.binding, template: term.template },
                  },
                  params,
                  condition,
                  bucketSeconds,
                  includeNowBucket: term.lastRun ? true : undefined,
                },
                runner
              ).then((m) => m.get("__agg__") ?? [])
        );
        series.push({
          key: term.paramKey,
          label: param.label,
          threshold,
          points: percentOfThreshold(
            term.lastRun ? silenceSeries(points, bucketSeconds, input.window, priorRunSec) : points,
            threshold
          ),
        });
      } catch (error) {
        logger.warn("alerts.detail.health_line_failed", {
          alertId: input.alertId,
          paramKey: term.paramKey,
          error,
        });
      }
    }
  }
  return { series };
}

// Seconds since the latest run, sampled at each bucket end; unknown (null) until a run is seen.
export function silenceSeries(
  lastRuns: MetricSeriesPoint[],
  bucketSeconds: number,
  window: AlertSeriesWindow,
  priorRunSec?: number | null
): MetricSeriesPoint[] {
  let last = priorRunSec ? priorRunSec * 1000 : null;
  const buckets = lastRuns.length
    ? lastRuns
    : fillMetricBuckets(
        [],
        window.since.getTime(),
        window.until.getTime(),
        bucketSeconds,
        null,
        true
      );
  return buckets.map((p) => {
    if (p.value) last = Math.max(last ?? 0, p.value * 1000);
    if (last === null) return { ...p, value: null };
    const end = Math.min(p.bucket + bucketSeconds * 1000, window.until.getTime());
    return { ...p, value: Math.max(0, (end - last) / 1000) };
  });
}

async function priorRunSeconds(
  term: HealthQueryTerm,
  params: AlertParams,
  templateParams: Record<string, number>,
  input: HealthQueryInput,
  runner: QueryRowRunner
): Promise<number | null> {
  const sinceMs = input.window.since.getTime();
  const col = term.template.match(/max\((\w+)\)/i)?.[1] ?? "triggered_at";
  const query = compileTemplate(term.template, {
    scope: `${scopeWhere(params)} AND ${col} < ${clickhouseDateTimeLiteral(input.window.since)}`,
    params: templateParams,
  });
  const rows = await runner(
    query,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: params.environmentId,
    },
    {
      from: new Date(sinceMs - PRE_WINDOW_LOOKBACK_MS).toISOString(),
      to: input.window.since.toISOString(),
    }
  );
  const value = Number(Object.values(rows[0] ?? {})[0]);
  return value > 0 ? value : null;
}

async function worstGroupSeries(
  term: HealthQueryTerm & { groupBy: string },
  table: string,
  params: AlertParams,
  templateParams: Record<string, number>,
  evalWindow: EvaluationWindow | undefined,
  bucketSeconds: number,
  input: HealthQueryInput,
  runner: QueryRowRunner
): Promise<MetricSeriesPoint[]> {
  const sinceMs = input.window.since.getTime();
  const untilMs = input.window.until.getTime();
  const maxBuckets = Math.ceil((untilMs - sinceMs) / (bucketSeconds * 1000)) + 1;
  const rows = await runner(
    worstGroupQuery(term, table, params, templateParams, bucketSeconds, maxBuckets, evalWindow),
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: params.environmentId,
    },
    { from: input.window.since.toISOString(), to: input.window.until.toISOString() }
  );
  const points = rows
    .filter((r) => r.value !== null && r.value !== undefined)
    .map((r) => ({
      bucket: parseClickhouseDateTime(r.bucket as string).getTime(),
      value: Number(r.value) || 0,
    }));
  return points.length === 0
    ? []
    : fillMetricBuckets(points, sinceMs, untilMs, bucketSeconds, null, undefined, maxBuckets);
}

const APPROACHING_TEMPLATE =
  /^SELECT\s+(?:(\w+),\s+)?\(.*?\) AS met, (.+?) AS reading_(?:value|count), .+? AS samples FROM (\S+) WHERE \{\{scope\}\}(.*)$/s;

export function limitTileQuery(
  capability: AlertCapability,
  params: AlertParams,
  templateParams: Record<string, number>,
  bucketSeconds: number,
  maxBuckets: number
): string | undefined {
  const source = capability.binding.signalTemplates?.approaching;
  const match = source ? APPROACHING_TEMPLATE.exec(source) : null;
  if (!match) {
    logger.warn("alerts.detail.limit_tile_template_unmatched", { key: capability.key });
    return undefined;
  }
  const [, groupBy, reading, table, tail] = match;
  return buildBucketedQuery({
    template: `SELECT ${reading} FROM ${table} WHERE {{scope}}${tail!.replace(/\s+GROUP BY .*$/s, "")}`,
    table: table!,
    scope: scopeWhere(params),
    bucketSeconds,
    maxBuckets,
    grouped: false,
    templateParams,
    partitionBy: groupBy,
  });
}

export function limitTileKeys(capability: AlertCapability, condition?: Condition): string[] {
  if (!capability.binding.compositeOf) {
    return isLimitComponent(capability.key) ? [capability.key] : [];
  }
  return selectedComponents(capability, condition).filter(isLimitComponent);
}

export async function getLimitTileSeries(
  input: HealthQueryInput,
  runner: QueryRowRunner
): Promise<LimitTileSeries[]> {
  let params: AlertParams;
  let condition;
  try {
    params = alertParamsSchema.parse(input.params);
    const parsed = conditionSchema.parse(input.condition);
    condition = parsed.kind === "state" ? parsed : undefined;
  } catch {
    return [];
  }
  const sinceMs = input.window.since.getTime();
  const untilMs = input.window.until.getTime();
  const buildTile = async (key: string): Promise<LimitTileSeries | undefined> => {
    const capability = getCapability(key);
    if (!capability) return undefined;
    const templateParams = resolveEffectiveParams(condition, capability.binding.params);
    const bucketSeconds = windowBucketSeconds(input.window, capability.binding.minCadenceSec);
    const maxBuckets = Math.ceil((untilMs - sinceMs) / (bucketSeconds * 1000)) + 1;
    const fetchPoints = async () => {
      const query = limitTileQuery(capability, params, templateParams, bucketSeconds, maxBuckets);
      if (!query) return [];
      try {
        const rows = await withRetry(() =>
          runner(
            query,
            {
              organizationId: input.organizationId,
              projectId: input.projectId,
              environmentId: params.environmentId,
            },
            { from: input.window.since.toISOString(), to: input.window.until.toISOString() }
          )
        );
        const sampled = rows
          .filter((r) => r.value !== null && r.value !== undefined)
          .map((r) => ({
            bucket: parseClickhouseDateTime(r.bucket as string).getTime(),
            value: Number(r.value) || 0,
          }));
        return sampled.length === 0
          ? []
          : fillMetricBuckets(
              sampled,
              sinceMs,
              untilMs,
              bucketSeconds,
              null,
              undefined,
              maxBuckets
            );
      } catch (error) {
        logger.warn("alerts.detail.limit_tile_failed", {
          alertId: input.alertId,
          key,
          error,
        });
        return null;
      }
    };
    const points = await fetchPoints();
    return {
      key,
      label: capability.shortTitle ?? capability.title,
      threshold: templateParams.utilisationPct ?? null,
      points: points ?? [],
      failed: points === null,
    };
  };
  const tiles: (LimitTileSeries | undefined)[] = [];
  for (const key of limitTileKeys(input.capability, condition)) tiles.push(await buildTile(key));
  return tiles.filter((tile): tile is LimitTileSeries => tile !== undefined);
}

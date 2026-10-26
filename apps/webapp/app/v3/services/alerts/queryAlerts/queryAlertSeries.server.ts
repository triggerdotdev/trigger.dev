import {
  compileTemplate,
  type AlertParams,
  type Condition,
  type QuerySignal,
} from "@internal/alert-contracts";
import { QueryError } from "@internal/clickhouse";
import { selectStatementText } from "@internal/tsql";
import type { MetricSeriesPoint } from "~/components/alerts/alertSeriesTypes";
import { logger } from "~/services/logger.server";
import { isQueryConcurrencyRejection } from "~/services/queryService.server";
import type { AlertSeriesWindow } from "../alertSeries.server";
import {
  clickhouseDateTimeLiteral,
  CONTEXT_HORIZON_SEC,
  identifier,
  MAX_QUERY_GROUPS,
  rowKeyPart,
  sourceWindows,
  type QueryRowRunner,
  type WindowCondition,
} from "../evaluators/queryEvaluator.server";
import type { ResolvedAlertCapability } from "./resolveAlertCapability.server";

const MAX_QUERY_SERIES_BUCKETS = 32;
const SCALAR_SERIES_KEY = "__agg__";
const BUCKET_COLUMN = "__bucket";
const COUNT_COLUMN = "__count";
const MINUTE_MS = 60_000;

export type QuerySeriesMode = QuerySignal["mode"];

const CONCURRENCY_RETRIES = 2;

async function retryConcurrencyRejection<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= CONCURRENCY_RETRIES || !isQueryConcurrencyRejection(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400));
    }
  }
}

export type QueryAlertSeriesInput = {
  alert: { id: string; organizationId: string; projectId: string; params: AlertParams };
  capability: ResolvedAlertCapability | undefined;
  condition: Condition;
  window: AlertSeriesWindow;
  maxBuckets?: number;
};

/** Bucket ends, a whole number of minutes apart, the last one at the window's end. */
export function queryBucketEnds(
  window: AlertSeriesWindow,
  windowSec: number,
  maxBuckets = MAX_QUERY_SERIES_BUCKETS
): { stepMs: number; ends: number[] } {
  const endMs = Math.floor(window.until.getTime() / MINUTE_MS) * MINUTE_MS;
  const spanMs = Math.max(0, window.until.getTime() - window.since.getTime());
  const windowStepMs =
    Math.max(1, Math.ceil(Math.max(windowSec * 1000, spanMs / maxBuckets) / MINUTE_MS)) * MINUTE_MS;
  // A span shorter than two windows still gets two readings, from overlapping windows.
  const stepMs =
    spanMs < 2 * windowStepMs && spanMs >= 2 * MINUTE_MS
      ? Math.floor(spanMs / 2 / MINUTE_MS) * MINUTE_MS
      : windowStepMs;
  const count = Math.max(1, Math.min(maxBuckets, Math.floor(spanMs / stepMs)));
  return {
    stepMs,
    ends: Array.from({ length: count }, (_, i) => endMs - (count - 1 - i) * stepMs),
  };
}

type Branch = { bucket: number; statement: string; windows: WindowCondition[] };

function thresholdBranches(
  template: string,
  bucketColumn: string,
  columns: string[],
  signal: QuerySignal,
  windowSec: number,
  ends: number[]
): Branch[] {
  const statement = selectStatementText(template);
  return ends.map((end, branch) => ({
    bucket: end,
    statement: [
      `SELECT ${end} AS ${identifier(bucketColumn)}, ${columns.map(identifier).join(", ")} FROM (`,
      statement,
      `) LIMIT ${MAX_QUERY_GROUPS + 1}`,
    ].join("\n"),
    windows: sourceWindows(signal, () => ({
      from: new Date(end - windowSec * 1000),
      to: new Date(end),
    })).map((w) => ({ ...w, branch })),
  }));
}

function matchBranches(
  template: string,
  signal: QuerySignal,
  stepMs: number,
  ends: number[]
): Branch[] {
  return ends.map((end, branch) => {
    const start = end - stepMs;
    const window = { from: new Date(start), to: new Date(end) };
    const context = { from: new Date(end - CONTEXT_HORIZON_SEC * 1000), to: new Date(end) };
    const wrapper = compileTemplate(template, "1 = 1", undefined, {
      checkpoint: clickhouseDateTimeLiteral(window.from),
      until: clickhouseDateTimeLiteral(window.to),
      after: "1 = 1",
    });
    return {
      bucket: start,
      statement: `SELECT ${start} AS ${BUCKET_COLUMN}, count() AS ${COUNT_COLUMN} FROM (\n${wrapper}\n)`,
      windows: sourceWindows(signal, (source) =>
        source.sourceId === signal.rowId?.sourceId ? window : context
      ).map((w) => ({ ...w, branch })),
    };
  });
}

function numberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The alert's own value over time: threshold/absence plot the windowed value at each
 * bucket end, match plots the number of new matching rows per bucket.
 */
export async function getQueryAlertSeries(
  input: QueryAlertSeriesInput,
  runner: QueryRowRunner
): Promise<Map<string, MetricSeriesPoint[]>> {
  const resolved = input.capability;
  const signal = input.alert.params.querySignal;
  const binding = resolved?.capability.binding;
  if (!resolved || resolved.unavailable || !signal || !binding?.template) return new Map();

  const condition = input.condition;
  const match = condition.kind === "occurrence";
  const windowSec =
    condition.kind === "threshold"
      ? condition.windowSec
      : condition.kind === "absence"
        ? condition.quietWindowSec
        : 0;
  if (!match && (!windowSec || !binding.measure)) return new Map();

  const { stepMs, ends } = queryBucketEnds(input.window, windowSec, input.maxBuckets);
  const groupBy = binding.groupBy ?? [];
  const columns = match ? [] : [binding.measure!, ...groupBy];
  let bucketColumn = BUCKET_COLUMN;
  while (columns.includes(bucketColumn)) bucketColumn = `_${bucketColumn}`;
  const branches = match
    ? matchBranches(binding.template, signal, stepMs, ends)
    : thresholdBranches(binding.template, bucketColumn, columns, signal, windowSec, ends);
  const windows = branches.flatMap((b) => b.windows);
  const last = ends[ends.length - 1]!;

  let rows: Record<string, unknown>[];
  try {
    rows = await retryConcurrencyRejection(() =>
      runner(
        branches.map((b) => b.statement).join("\nUNION ALL\n"),
        {
          organizationId: input.alert.organizationId,
          projectId: input.alert.projectId,
          environmentId: input.alert.params.environmentId,
        },
        // Picks the rollup, so it must match the evaluator's single window, not the chart span.
        {
          from: new Date(last - (match ? stepMs : windowSec * 1000)).toISOString(),
          to: new Date(last).toISOString(),
        },
        { windowConditions: windows, maxRows: branches.length * (MAX_QUERY_GROUPS + 1) }
      )
    );
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    logger.warn("Query alert series failed", { alertId: input.alert.id, error: error.message });
    return new Map();
  }

  const buckets = branches.map((b) => b.bucket);
  const byBucket = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const bucket = Number(row[bucketColumn]);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), row]);
  }

  if (match) {
    return new Map([
      [
        SCALAR_SERIES_KEY,
        buckets.map((bucket) => ({
          bucket,
          value: numberOrNull(byBucket.get(bucket)?.[0]?.[COUNT_COLUMN]) ?? 0,
        })),
      ],
    ]);
  }

  const measure = binding.measure!;
  const empty = condition.kind === "absence" || resolved.countLike ? 0 : null;
  if (!groupBy.length) {
    return new Map([
      [
        SCALAR_SERIES_KEY,
        buckets.map((bucket) => ({
          bucket,
          value: numberOrNull(byBucket.get(bucket)?.[0]?.[measure]) ?? empty,
        })),
      ],
    ]);
  }

  const valuesByKey = new Map<string, Map<number, number | null>>();
  const overCap = new Set<number>();
  for (const [bucket, bucketRows] of byBucket) {
    // Past the group cap the evaluator reports the window unavailable, so leave a gap.
    if (bucketRows.length > MAX_QUERY_GROUPS) {
      overCap.add(bucket);
      continue;
    }
    for (const row of bucketRows) {
      const key = groupBy.map((col) => rowKeyPart(row[col])).join(", ");
      const values = valuesByKey.get(key) ?? new Map<number, number | null>();
      values.set(bucket, numberOrNull(row[measure]));
      valuesByKey.set(key, values);
    }
  }
  return new Map(
    Array.from(valuesByKey, ([key, values]) => [
      key,
      buckets.map((bucket) => ({
        bucket,
        value: values.has(bucket) ? values.get(bucket)! : overCap.has(bucket) ? null : empty,
        key,
      })),
    ])
  );
}

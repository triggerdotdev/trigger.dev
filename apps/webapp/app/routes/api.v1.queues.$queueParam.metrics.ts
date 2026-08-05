import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// `?type=task` (the default) adds the `task/` prefix to `queueParam`. An unknown queue
// returns zeroed metrics, not a 404.

const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const MAX_PERIOD_MS = 7 * UNIT_MS.d;

const PeriodSchema = z
  .string()
  .regex(/^[1-9]\d*[smhdw]$/, "period must be a shorthand like '15m', '1h', or '24h'")
  .refine(
    (p) => Number(p.slice(0, -1)) * UNIT_MS[p.slice(-1)] <= MAX_PERIOD_MS,
    "period is too large (max 7d)"
  );

const SearchParamsSchema = z.object({
  type: z.enum(["task", "custom"]).default("task"),
  period: PeriodSchema.default("1h"),
});

const TREND_POINTS = 12;

function periodMs(period: string): number {
  return Number(period.slice(0, -1)) * UNIT_MS[period.slice(-1)];
}

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const loader = createLoaderApiRoute(
  {
    params: z.object({
      queueParam: z.string().transform((val) => val.replace(/%2F/g, "/")),
    }),
    searchParams: SearchParamsSchema,
    allowJWT: true,
    corsStrategy: "none",
    findResource: async () => 1, // dummy — the queue name isn't resolved against Postgres
    authorization: {
      action: "read",
      resource: () => ({ type: "query", id: "queue_metrics" }),
    },
  },
  async ({ params, searchParams, authentication }) => {
    // Already decoded by Remix and the schema; decoding again would 500 on a literal "%".
    const name = params.queueParam;
    const queue = searchParams.type === "task" && !name.startsWith("task/") ? `task/${name}` : name;

    const windowMs = periodMs(searchParams.period);
    const windowMinutes = windowMs / 60_000;
    const bucketSeconds = Math.max(60, Math.round(windowMs / 1000 / TREND_POINTS));
    // Snap both bounds to the bucket grid so repeated calls share ClickHouse cache entries.
    const endMs = Math.ceil(Date.now() / (bucketSeconds * 1000)) * bucketSeconds * 1000;
    const startMs = endMs - windowMs;

    try {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        authentication.environment.organizationId,
        "query"
      );

      const ids = {
        organizationId: authentication.environment.organizationId,
        projectId: authentication.environment.projectId,
        environmentId: authentication.environment.id,
        queueNames: [queue],
        startTime: formatClickhouseDateTime(new Date(startMs)),
        endTime: formatClickhouseDateTime(new Date(endMs)),
      };

      const [summaryResult, trendResult] = await Promise.all([
        clickhouse.queueMetrics.listSummary(ids),
        clickhouse.queueMetrics.depthSparklines({ ...ids, bucketSeconds }),
      ]);

      const [summaryError, summaryRows] = summaryResult;
      const [trendError, trendRows] = trendResult;

      if (summaryError || trendError) {
        logger.warn("Failed to read queue metrics", {
          summaryError: summaryError?.message,
          trendError: trendError?.message,
          organizationId: ids.organizationId,
          projectId: ids.projectId,
          environmentId: ids.environmentId,
        });
        return json({ error: "Queue metrics are unavailable right now." }, { status: 503 });
      }

      const summary = summaryRows?.[0];
      const startedCount = summary?.started_count ?? 0;

      return json({
        queue,
        period: searchParams.period,
        from: new Date(startMs).toISOString(),
        to: new Date(endMs).toISOString(),
        waitMs: {
          p50: finiteOrNull(summary?.p50_wait_ms),
          p95: finiteOrNull(summary?.p95_wait_ms),
        },
        peakQueued: summary?.peak_queued ?? 0,
        startedCount,
        startedPerMin: Number((startedCount / windowMinutes).toFixed(2)),
        throttledCount: summary?.throttled_count ?? 0,
        bucketIntervalMs: bucketSeconds * 1000,
        // Oldest first; buckets with no sample are omitted, so gaps carry the previous depth.
        depthTrend: (trendRows ?? [])
          .slice()
          .sort((a, b) => a.bucket.localeCompare(b.bucket))
          .map((row) => row.depth),
      });
    } catch (error) {
      // Rethrow Responses: swallowing one would turn it into a 500.
      if (error instanceof Response) throw error;
      logger.error("Failed to read queue metrics", {
        error,
        queue,
        organizationId: authentication.environment.organizationId,
        projectId: authentication.environment.projectId,
        environmentId: authentication.environment.id,
      });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);

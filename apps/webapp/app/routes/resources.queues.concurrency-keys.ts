import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import {
  QUEUE_METRICS_DEFAULT_PERIOD,
  clipQueueMetricsWindow,
} from "~/components/queues/queueMetricsPeriod";
import { queueMetricsMaxPeriodDays } from "~/components/queues/queueMetricsPeriod.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { findEnvironmentById, hasAccessToEnvironment } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { engine } from "~/v3/runEngine.server";

// One page of a queue's concurrency keys. The ClickHouse tier (queue_metrics_ck_v1) is the
// paginated authority — ranked by peak backlog over the window with the total on every row
// (single scan) — and the ≤PER_PAGE keys on the page are enriched with live "now" counts from
// Redis (O(page), independent of total key cardinality). This replaces the old top-50 cap.
export const CONCURRENCY_KEYS_PER_PAGE = 25;

const DEFAULT_PERIOD = QUEUE_METRICS_DEFAULT_PERIOD;

const Body = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  /** The queue's full name (e.g. `task/my-task` or a custom queue name). */
  queueName: z.string(),
  period: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  /** Case-insensitive substring filter on the key. */
  search: z.string().nullish(),
  page: z.number().int().min(1).default(1),
});

export type ConcurrencyKeyRow = {
  key: string;
  queued: number;
  running: number;
  oldestWaitMs: number | null;
  started: number;
  peakBacklog: number;
  peakRunning: number;
  meanWaitMs: number;
};

export type ConcurrencyKeysResponse =
  | {
      success: true;
      rows: ConcurrencyKeyRow[];
      total: number;
      page: number;
      perPage: number;
      loadedAt: number;
    }
  | { success: false; error: string };

// Snap the window to a minute grid so repeated loads within a bucket produce identical query
// params and share ClickHouse query-cache entries (same trick as the queue-list ranking).
function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
function floorToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}
function ceilToMinute(ms: number): number {
  return Math.ceil(ms / 60_000) * 60_000;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);

  const submission = Body.safeParse(await request.json());
  if (!submission.success) {
    return json<ConcurrencyKeysResponse>(
      { success: false, error: "Invalid input" },
      { status: 400 }
    );
  }
  const { organizationId, projectId, environmentId, queueName, period, from, to, search, page } =
    submission.data;

  const hasAccess = await hasAccessToEnvironment({
    environmentId,
    projectId,
    organizationId,
    userId,
  });
  if (!hasAccess) {
    return json<ConcurrencyKeysResponse>(
      { success: false, error: "You don't have permission for this resource" },
      { status: 403 }
    );
  }

  // Needed as the tenant scope for the live Redis lookup (organization/project/environment ids).
  const environment = await findEnvironmentById(environmentId);
  if (!environment) {
    return json<ConcurrencyKeysResponse>(
      { success: false, error: "Environment not found" },
      { status: 404 }
    );
  }

  // Gate on the per-org Queue Metrics UI flag, matching the queue detail page and run inspector, so
  // this endpoint's data isn't reachable for orgs that can't see the UI. 404 (not 403) to hide it.
  if (
    !(await canAccessQueueMetricsUi({
      request,
      userId,
      organizationSlug: environment.organization.slug,
    }))
  ) {
    return json<ConcurrencyKeysResponse>({ success: false, error: "Not found" }, { status: 404 });
  }

  const range = clipQueueMetricsWindow(
    timeFilterFromTo({
      period: period ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
      defaultPeriod: DEFAULT_PERIOD,
    }),
    await queueMetricsMaxPeriodDays(organizationId)
  );
  const startTime = formatClickhouseDateTime(new Date(floorToMinute(range.from.getTime())));
  const endTime = formatClickhouseDateTime(new Date(ceilToMinute(range.to.getTime())));

  try {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      organizationId,
      "queueMetrics"
    );

    const [rankingError, rankingRows] = await clickhouse.queueMetrics.concurrencyKeyRanking({
      organizationId,
      projectId,
      environmentId,
      queueName,
      startTime,
      endTime,
      nameContains: search?.trim() ?? "",
      limit: CONCURRENCY_KEYS_PER_PAGE,
      offset: (page - 1) * CONCURRENCY_KEYS_PER_PAGE,
    });
    if (rankingError) {
      throw rankingError;
    }

    const total = rankingRows?.[0]?.ranked_total ?? 0;
    const keys = (rankingRows ?? []).map((r) => r.concurrency_key);

    // Enrich just this page's keys with live "now" counts from Redis.
    const live = await engine.concurrencyKeyLiveStats(environment, queueName, keys);
    const loadedAt = Date.now();

    const rows: ConcurrencyKeyRow[] = (rankingRows ?? []).map((r) => {
      const l = live.get(r.concurrency_key);
      const oldestWaitMs =
        l && l.oldestEnqueuedAt != null ? Math.max(0, loadedAt - l.oldestEnqueuedAt) : null;
      return {
        key: r.concurrency_key,
        queued: l?.queued ?? 0,
        running: l?.running ?? 0,
        oldestWaitMs,
        started: r.started,
        peakBacklog: r.peak_backlog,
        peakRunning: r.peak_running,
        meanWaitMs: r.mean_wait_ms,
      };
    });

    return json<ConcurrencyKeysResponse>({
      success: true,
      rows,
      total,
      page,
      perPage: CONCURRENCY_KEYS_PER_PAGE,
      loadedAt,
    });
  } catch (error) {
    return json<ConcurrencyKeysResponse>(
      { success: false, error: error instanceof Error ? error.message : "Query failed" },
      { status: 400 }
    );
  }
};

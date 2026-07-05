import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import {
  Chart,
  type ChartConfig,
  type ChartState,
} from "~/components/primitives/charts/ChartCompound";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import {
  useMetricResourceQuery,
  type MetricResourceTimeRange,
} from "~/hooks/useMetricResourceQuery";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: `Queue metrics | Trigger.dev` }];

const ParamsSchema = EnvironmentParamSchema.extend({ queueParam: z.string() });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, queueParam } = ParamsSchema.parse(params);

  // This whole page is part of the metrics UI; gate it per-org (the list already hides
  // the only link to it, this is defense in depth).
  if (!(await canAccessQueueMetricsUi({ userId, organizationSlug }))) {
    throw new Response(undefined, { status: 404, statusText: "Not found" });
  }

  const url = new URL(request.url);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment)
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const retrieve = await new QueueRetrievePresenter().call({ environment, queueInput: queueParam });
  if (!retrieve.success) {
    throw new Response(undefined, { status: 404, statusText: "Queue not found" });
  }

  const queue = retrieve.queue;
  const fullName = queue.type === "task" ? `task/${queue.name}` : queue.name;

  // Charts + CH-derived stats are fetched client-side per card (see QueueDetailChartCard /
  // useQueueMetric) so the drill-down renders instantly. The loader only returns the live
  // "now" counts + identifiers the client fetches need.
  return typedjson({
    queue,
    fullName,
    backPath: url.pathname.replace(/\/[^/]+$/, ""),
    ids: {
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
    },
  });
};

const COLORS = {
  running: "#6366F1",
  limit: "#4D525B",
  queued: "#A78BFA",
  p50: "#22D3EE",
  p95: "#F59E0B",
  p99: "#EF4444",
  throttled: "#F59E0B",
};

type Ids = { organizationId: string; projectId: string; environmentId: string };

type TimeRangeParams = MetricResourceTimeRange;

const QUEUE_METRICS_DEFAULT_PERIOD = "1d";

export default function Page() {
  const { queue, fullName, backPath, ids } = useTypedLoaderData<typeof loader>();
  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  const { value } = useSearchParams();
  const timeRange: TimeRangeParams = {
    period: value("period") ?? null,
    from: value("from") ?? null,
    to: value("to") ?? null,
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={queue.name} backButton={{ to: backPath, text: "Queues" }} />
      </NavBar>
      <PageBody>
        <div className="flex flex-col gap-4 p-3">
          <div className="flex items-start justify-between gap-2">
            <QueueStats
              queue={{ running: queue.running, queued: queue.queued }}
              ids={ids}
              timeRange={timeRange}
              queueName={fullName}
            />
            <TimeFilter
              defaultPeriod={QUEUE_METRICS_DEFAULT_PERIOD}
              labelName="Period"
              hideLabel
              maxPeriodDays={maxPeriodDays}
              valueClassName="text-text-bright"
              shortcut={{ key: "d" }}
            />
          </div>

          <QueueDetailChartCard
            title="Concurrency"
            query={`SELECT timeBucket() AS t, max(max_running) AS running, max(max_limit) AS limit\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            timeRange={timeRange}
            queueName={fullName}
            series={[
              { key: "running", label: "Running", color: COLORS.running },
              { key: "limit", label: "Limit", color: COLORS.limit },
            ]}
          />
          <QueueDetailChartCard
            title="Queue depth (backlog)"
            query={`SELECT timeBucket() AS t, max(max_queued) AS queued\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            timeRange={timeRange}
            queueName={fullName}
            series={[{ key: "queued", label: "Queued", color: COLORS.queued }]}
          />
          <QueueDetailChartCard
            title="Scheduling delay"
            query={`SELECT timeBucket() AS t,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[1]) AS p50,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS p95,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[4]) AS p99\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            timeRange={timeRange}
            queueName={fullName}
            valueFormat={formatWaitMs}
            series={[
              { key: "p50", label: "p50", color: COLORS.p50 },
              { key: "p95", label: "p95", color: COLORS.p95 },
              { key: "p99", label: "p99", color: COLORS.p99 },
            ]}
          />
          <QueueDetailChartCard
            title="Throttled buckets"
            query={`SELECT timeBucket() AS t, sum(throttled_count) AS throttled\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            timeRange={timeRange}
            queueName={fullName}
            series={[{ key: "throttled", label: "Throttled", color: COLORS.throttled }]}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}

function useQueueMetric(
  query: string,
  opts: { ids: Ids; timeRange: TimeRangeParams; queueName: string; fillGaps?: boolean }
) {
  return useMetricResourceQuery(query, {
    ...opts.ids,
    timeRange: opts.timeRange,
    defaultPeriod: QUEUE_METRICS_DEFAULT_PERIOD,
    queues: [opts.queueName],
    fillGaps: opts.fillGaps,
  });
}

function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clickhouseTimeToMs(value: unknown): number {
  const s = String(value).replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}

type SeriesConfig = { key: string; label: string; color: string };

function QueueDetailChartCard({
  title,
  query,
  series,
  ids,
  timeRange,
  queueName,
  valueFormat,
  fillGaps,
}: {
  title: string;
  query: string;
  series: SeriesConfig[];
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
  valueFormat?: (value: number) => string;
  fillGaps?: boolean;
}) {
  const { rows, showLoading, failed } = useQueueMetric(query, {
    ids,
    timeRange,
    queueName,
    fillGaps,
  });

  const data = useMemo(() => {
    return rows
      .map((r) => {
        const point: { bucket: number } & Record<string, number> = {
          bucket: clickhouseTimeToMs(r.t),
        };
        for (const s of series) point[s.key] = toNumber(r[s.key]);
        return point;
      })
      .filter((p) => Number.isFinite(p.bucket));
  }, [rows, series]);

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const s of series) cfg[s.key] = { label: s.label, color: s.color };
    return cfg;
  }, [series]);

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(data),
    [data]
  );

  const state: ChartState = showLoading ? "loading" : failed ? "invalid" : undefined;

  return (
    <div className="h-64">
      <ChartCard title={title}>
        <Chart.Root
          config={chartConfig}
          data={data}
          dataKey="bucket"
          series={series.map((s) => s.key)}
          state={state}
          fillContainer
        >
          <Chart.Line
            lineType="monotone"
            xAxisProps={{ tickFormatter }}
            yAxisProps={valueFormat ? { tickFormatter: (v: number) => valueFormat(v) } : undefined}
            tooltipLabelFormatter={tooltipLabelFormatter}
            tooltipValueFormatter={valueFormat}
          />
        </Chart.Root>
      </ChartCard>
    </div>
  );
}

function QueueStats({
  queue,
  ids,
  timeRange,
  queueName,
}: {
  queue: { running: number; queued: number };
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
}) {
  // One scalar query feeds the CH-derived stats; the "now" counts come from the loader (live).
  const { rows, showLoading } = useQueueMetric(
    `SELECT max(max_limit) AS lim, max(max_queued) AS peak_queued, deltaSumTimestampMerge(started_delta) AS started,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS worst_p95\nFROM queue_metrics`,
    { ids, timeRange, queueName }
  );
  const row = rows[0];
  const worstP95 = row ? toNumber(row.worst_p95) : 0;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      <Stat label="Running now" value={queue.running.toLocaleString()} />
      <Stat label="Queued now" value={queue.queued.toLocaleString()} />
      <Stat
        label="Limit"
        value={row ? toNumber(row.lim).toLocaleString() : "–"}
        loading={showLoading}
      />
      <Stat
        label="Peak queued"
        value={row ? toNumber(row.peak_queued).toLocaleString() : "–"}
        loading={showLoading}
      />
      <Stat
        label="Started"
        value={row ? toNumber(row.started).toLocaleString() : "–"}
        loading={showLoading}
      />
      <Stat
        label="Delay p95"
        value={worstP95 > 0 ? formatWaitMs(worstP95) : "–"}
        loading={showLoading}
        className={worstP95 >= 60_000 ? "text-warning" : undefined}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  loading,
}: {
  label: string;
  value: string;
  className?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-sm border border-grid-dimmed bg-background-bright px-3 py-2">
      <div className="text-xs text-text-dimmed">{label}</div>
      {loading ? (
        <div className="mt-1 h-6 w-12 animate-pulse rounded bg-grid-bright/50" />
      ) : (
        <div className={cn("text-2xl tabular-nums text-text-bright", className)}>{value}</div>
      )}
    </div>
  );
}

function formatWaitMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

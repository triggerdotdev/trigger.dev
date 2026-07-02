import { useSearchParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { LoadingBarDivider } from "~/components/primitives/LoadingBarDivider";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useInterval } from "~/hooks/useInterval";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  isQueueMetricsWindow,
  type QueueMetricsWindow,
} from "~/presenters/v3/QueueMetricsPresenter.server";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
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
  const rawPeriod = url.searchParams.get("period") ?? undefined;
  const period: QueueMetricsWindow = isQueueMetricsWindow(rawPeriod) ? rawPeriod : "24h";

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

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
    period,
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

export default function Page() {
  const { queue, fullName, period, backPath, ids } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={queue.name} backButton={{ to: backPath, text: "Queues" }} />
      </NavBar>
      <PageBody>
        <div className="flex flex-col gap-4 p-3">
          <div className="flex items-center justify-between gap-2">
            <QueueStats
              queue={{ running: queue.running, queued: queue.queued }}
              ids={ids}
              period={period}
              queueName={fullName}
            />
            <QueuePeriodSelect period={period} />
          </div>

          <QueueDetailChartCard
            title="Concurrency"
            query={`SELECT timeBucket() AS t, max(max_running) AS running, max(max_limit) AS limit\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            period={period}
            queueName={fullName}
            series={[
              { key: "running", label: "Running", color: COLORS.running },
              { key: "limit", label: "Limit", color: COLORS.limit, dashed: true },
            ]}
          />
          <QueueDetailChartCard
            title="Queue depth (backlog)"
            query={`SELECT timeBucket() AS t, max(max_queued) AS queued\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            period={period}
            queueName={fullName}
            series={[{ key: "queued", label: "Queued", color: COLORS.queued }]}
          />
          <QueueDetailChartCard
            title="Scheduling delay"
            query={`SELECT timeBucket() AS t,\n  round(quantilesMerge(0.5, 0.95, 0.99)(wait_quantiles)[1]) AS p50,\n  round(quantilesMerge(0.5, 0.95, 0.99)(wait_quantiles)[2]) AS p95,\n  round(quantilesMerge(0.5, 0.95, 0.99)(wait_quantiles)[3]) AS p99\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
            fillGaps
            ids={ids}
            period={period}
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
            period={period}
            queueName={fullName}
            series={[{ key: "throttled", label: "Throttled", color: COLORS.throttled }]}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}

type MetricRow = Record<string, number | string | null>;
type MetricResponse =
  | { success: true; data: { rows: MetricRow[] } }
  | { success: false; error: string };

/**
 * Client-fetch a queue-scoped TRQL query from the metric resource route, mirroring the
 * dashboard widgets: own loading state, 60s + on-focus refresh, abort on change/unmount.
 */
function useQueueMetric(
  query: string,
  opts: { ids: Ids; period: string; queueName: string; fillGaps?: boolean }
) {
  const [rows, setRows] = useState<MetricRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { ids, period, queueName, fillGaps } = opts;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    fetch("/resources/metric", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        scope: "environment",
        period,
        from: null,
        to: null,
        fillGaps: !!fillGaps,
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        queues: [queueName],
      }),
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<MetricResponse>)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.success) {
          setRows(data.data.rows);
          setFailed(false);
        } else {
          setFailed(true);
        }
        setIsLoading(false);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setFailed(true);
          setIsLoading(false);
        }
      });
  }, [query, period, queueName, fillGaps, ids.organizationId, ids.projectId, ids.environmentId]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useInterval({ interval: 60_000, onLoad: false, onFocus: true, callback: load });

  return { rows: rows ?? [], showLoading: isLoading && !rows, failed };
}

function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clickhouseTimeToMs(value: unknown): number {
  const s = String(value).replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}

type SeriesConfig = { key: string; label: string; color: string; dashed?: boolean };

function QueueDetailChartCard({
  title,
  query,
  series,
  ids,
  period,
  queueName,
  valueFormat,
  fillGaps,
}: {
  title: string;
  query: string;
  series: SeriesConfig[];
  ids: Ids;
  period: string;
  queueName: string;
  valueFormat?: (value: number) => string;
  fillGaps?: boolean;
}) {
  const { rows, showLoading, failed } = useQueueMetric(query, { ids, period, queueName, fillGaps });

  const points = useMemo(() => {
    return rows
      .map((r) => {
        const point: Record<string, number> = { ts: clickhouseTimeToMs(r.t) };
        for (const s of series) point[s.key] = toNumber(r[s.key]);
        return point;
      })
      .filter((p) => Number.isFinite(p.ts));
  }, [rows, series]);

  const bucketIntervalMs = points.length >= 2 ? points[1].ts - points[0].ts : 0;
  const formatX = useMemo(() => {
    const sameDay = bucketIntervalMs > 0 && bucketIntervalMs < 6 * 3600_000;
    return (value: number) =>
      new Date(value).toLocaleString("en-US", {
        month: sameDay ? undefined : "short",
        day: sameDay ? undefined : "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  }, [bucketIntervalMs]);

  const hasData = points.some((p) => series.some((s) => p[s.key] > 0));

  return (
    <div className="rounded-md border border-grid-dimmed bg-background-dimmed p-3">
      <Header2 className="mb-1">{title}</Header2>
      <LoadingBarDivider isLoading={showLoading} className="mb-1 bg-transparent" />
      {showLoading ? (
        <div className="h-56 w-full animate-pulse rounded bg-grid-bright/40" />
      ) : failed ? (
        <div className="grid h-56 place-items-center text-text-dimmed">
          <Paragraph variant="small">Unable to load metrics</Paragraph>
        </div>
      ) : hasData ? (
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatX}
                minTickGap={64}
                height={24}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "#878C99" }}
              />
              <YAxis
                width={44}
                tickMargin={4}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "#878C99" }}
                tickFormatter={valueFormat ? (v: number) => valueFormat(v) : undefined}
                domain={[0, (dataMax: number) => Math.max(1, Math.ceil(dataMax * 1.15))]}
              />
              <Tooltip
                cursor={{ stroke: "rgba(255,255,255,0.12)" }}
                content={<QueueChartTooltip series={series} formatX={formatX} valueFormat={valueFormat} />}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 1000 }}
                animationDuration={0}
              />
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={1.5}
                  strokeDasharray={s.dashed ? "4 4" : undefined}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
              <ReferenceLine y={0} stroke="#2C3034" strokeWidth={1} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="grid h-56 place-items-center text-text-dimmed">
          <Paragraph variant="small">No activity in this window</Paragraph>
        </div>
      )}
    </div>
  );
}

function QueueChartTooltip({
  active,
  payload,
  label,
  series,
  formatX,
  valueFormat,
}: TooltipProps<number, string> & {
  series: SeriesConfig[];
  formatX: (value: number) => string;
  valueFormat?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-sm border border-grid-bright bg-background-bright px-3 py-2">
      <div className="mb-1 text-xs text-text-dimmed">{formatX(Number(label))}</div>
      {series.map((s) => {
        const entry = payload.find((p) => p.dataKey === s.key);
        const value = entry?.value;
        return (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="text-text-dimmed">{s.label}</span>
            <span className="tabular-nums text-text-bright">
              {value === null || value === undefined
                ? "–"
                : valueFormat
                  ? valueFormat(Number(value))
                  : Number(value).toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function QueueStats({
  queue,
  ids,
  period,
  queueName,
}: {
  queue: { running: number; queued: number };
  ids: Ids;
  period: string;
  queueName: string;
}) {
  // One scalar query feeds the CH-derived stats; the "now" counts come from the loader (live).
  const { rows, showLoading } = useQueueMetric(
    `SELECT max(max_limit) AS lim, max(max_queued) AS peak_queued, deltaSumTimestampMerge(started_delta) AS started,\n  round(quantilesMerge(0.5, 0.95, 0.99)(wait_quantiles)[2]) AS worst_p95\nFROM queue_metrics`,
    { ids, period, queueName }
  );
  const row = rows[0];
  const worstP95 = row ? toNumber(row.worst_p95) : 0;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      <Stat label="Running now" value={queue.running.toLocaleString()} />
      <Stat label="Queued now" value={queue.queued.toLocaleString()} />
      <Stat label="Limit" value={row ? toNumber(row.lim).toLocaleString() : "–"} loading={showLoading} />
      <Stat
        label="Peak queued"
        value={row ? toNumber(row.peak_queued).toLocaleString() : "–"}
        loading={showLoading}
      />
      <Stat label="Started" value={row ? toNumber(row.started).toLocaleString() : "–"} loading={showLoading} />
      <Stat
        label="Worst delay p95"
        value={worstP95 > 0 ? formatWaitMs(worstP95) : "–"}
        loading={showLoading}
        className={worstP95 >= 60_000 ? "text-warning" : undefined}
      />
    </div>
  );
}

const PERIODS: QueueMetricsWindow[] = ["1h", "6h", "24h"];

function QueuePeriodSelect({ period }: { period: QueueMetricsWindow }) {
  const [searchParams] = useSearchParams();
  const hrefFor = (value: QueueMetricsWindow) => {
    const next = new URLSearchParams(searchParams);
    next.set("period", value);
    return `?${next.toString()}`;
  };
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-text-dimmed">Period</span>
      {PERIODS.map((value) => (
        <LinkButton
          key={value}
          to={hrefFor(value)}
          variant={value === period ? "secondary/small" : "minimal/small"}
          className={cn(value === period ? "text-text-bright" : "text-text-dimmed")}
        >
          {value}
        </LinkButton>
      ))}
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
    <div className="rounded-md border border-grid-dimmed bg-background-dimmed px-3 py-2">
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

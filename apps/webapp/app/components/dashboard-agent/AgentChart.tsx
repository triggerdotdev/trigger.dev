import { ClipboardIcon } from "@heroicons/react/24/outline";
import { IconBraces, IconFileTypeCsv } from "@tabler/icons-react";
import type { ColumnFormatType, OutputColumnMetadata } from "@internal/clickhouse";
import type { ChartBlock } from "@internal/dashboard-agent";
import type { AgentIntent, ChartAction } from "@internal/dashboard-agent-contracts";
import { useMemo } from "react";
import { createYAxisFormatter } from "~/components/code/QueryResultsChart";
import { Button } from "~/components/primitives/Buttons";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { ChartCardLegend } from "~/components/primitives/charts/ChartCardLegend";
import { type ChartState } from "~/components/primitives/charts/ChartCompound";
import { MetricChart } from "~/components/primitives/charts/MetricChart";
import { seriesFromRows } from "~/components/primitives/charts/seriesFromRows";
import {
  downsamplePoints,
  maxPointsForSeries,
  orderPointsByTime,
} from "~/components/primitives/charts/svgPointBudget";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useMetricResourceQuery } from "~/hooks/useMetricResourceQuery";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { AgentBlockToolsMenu } from "./AgentBlockToolsMenu";
import { copyRowsAsCSV, copyRowsAsJSON, copyText } from "./agent-block-tools";
import { ChatActionsRow } from "./chat-layout";
import { renderableActions } from "./view-actions";

const VALUE_FORMATS: Record<NonNullable<ChartBlock["valueFormat"]>, ColumnFormatType> = {
  number: "number",
  duration_ms: "duration",
  percent: "percent",
  bytes: "bytes",
};

// Query errors can carry SQL and schema detail, so the real one only goes to the console.
const CHART_ERROR_MESSAGE = "This chart's query couldn't run.";
const NO_CONTEXT_MESSAGE = "No environment context to run the query.";

// A query that buckets with timeBucket() almost always wants every bucket filled (zero, not
// missing) — otherwise a sparse series draws as one bar/point spanning the whole plot instead
// of a timeline. Detected off the query text since the block doesn't declare its x-axis kind.
// TSQL's gap-fill only recognizes timeBucket() — a hand-rolled toStartOfHour/Day query has no
// bucket width for it to fill on, so matching that here would be a silent no-op.
const TIME_BUCKET_QUERY = /\btimeBucket\(/i;

function defaultFillGaps(block: ChartBlock): boolean {
  return block.fillGaps ?? TIME_BUCKET_QUERY.test(block.query);
}

function ChartErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-error">
      {message}
    </div>
  );
}

export function ChartActions({
  actions,
  onIntent,
}: {
  actions: ChartAction[];
  onIntent?: (intent: AgentIntent) => void;
}) {
  const renderable = renderableActions(actions);
  if (!onIntent || renderable.length === 0) return null;
  return (
    <ChatActionsRow>
      {renderable.map((action, i) => (
        <Button
          key={i}
          variant={i === 0 ? "primary/small" : "secondary/small"}
          onClick={() => onIntent(action.intent as AgentIntent)}
        >
          {action.label}
        </Button>
      ))}
    </ChatActionsRow>
  );
}

// CSV export only needs the column name, not its ClickHouse type.
function columnsFromRows(rows: Record<string, unknown>[]): OutputColumnMetadata[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).map((name) => ({ name, type: "String" }));
}

export function AgentChart({
  block,
  onIntent,
}: {
  block: ChartBlock;
  onIntent?: (intent: AgentIntent) => void;
}) {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();

  const organizationId = organization?.id ?? "";
  const projectId = project?.id ?? "";
  const environmentId = environment?.id ?? "";
  const hasContext = !!organization && !!project && !!environment;
  // An empty query means nothing to ask for; missing context means nowhere to ask it either way.
  const query = hasContext ? block.query : "";

  const {
    rows,
    showLoading,
    failed,
    timeRange: serverTimeRange,
  } = useMetricResourceQuery(query, {
    organizationId,
    projectId,
    environmentId,
    timeRange: { period: block.period ?? null, from: null, to: null },
    defaultPeriod: block.period ?? "24h",
    fillGaps: defaultFillGaps(block),
    // The agent's own charts run once: no polling, no refresh on tab focus.
    refreshIntervalMs: 0,
    refetchOnFocus: false,
    userAuthoredQuery: true,
  });

  // For the x-axis's label granularity, not for gap-filling (the server does that): the query's
  // own resolved window, so a sparse or single-bucket series still spans the whole requested
  // range. Read off the response, not a client clock — no Date.now() during render.
  const timeRange = useMemo(() => {
    if (!serverTimeRange) return undefined;
    const from = Date.parse(serverTimeRange.from);
    const to = Date.parse(serverTimeRange.to);
    return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : undefined;
  }, [serverTimeRange]);

  // MetricChart's `invalid` state renders generic filter-mismatch copy; a query failure gets its
  // own message instead, so `state` only ever carries "loading" here.
  const state: ChartState = showLoading ? "loading" : undefined;
  const errorMessage = !hasContext ? NO_CONTEXT_MESSAGE : failed ? CHART_ERROR_MESSAGE : null;

  const { points, series, totalSeriesCount } = useMemo(
    () =>
      seriesFromRows(rows, {
        xAxisColumn: block.xAxisColumn,
        yAxisColumns: block.yAxisColumns,
        groupByColumn: block.groupByColumn ?? undefined,
        aggregation: block.aggregation ?? "sum",
      }),
    [rows, block.xAxisColumn, block.yAxisColumns, block.groupByColumn, block.aggregation]
  );

  // MetricChart renders one SVG element per point per series — downsample before handing points
  // over, or a large grouped result (up to 10,000 buckets x MAX_SERIES) renders hundreds of
  // thousands of nodes, twice (inline + fullscreen share this `chart`). `seriesFromRows` preserves
  // response order, so an unordered result (e.g. a GROUP BY with no ORDER BY) must be sorted
  // chronologically first — otherwise downsampling bucket-aggregates unrelated timestamps.
  const chartPoints = useMemo(
    () =>
      downsamplePoints(
        orderPointsByTime(points),
        maxPointsForSeries(series.length),
        series.map((s) => s.key),
        block.aggregation ?? "sum"
      ),
    [points, series, block.aggregation]
  );

  const valueFormat = useMemo(() => {
    const format = block.valueFormat ? VALUE_FORMATS[block.valueFormat] : undefined;
    return createYAxisFormatter(
      chartPoints,
      series.map((s) => s.key),
      format
    );
  }, [chartPoints, series, block.valueFormat]);

  const hasRows = rows.length > 0;
  const tools = [
    ...(block.query
      ? [{ icon: ClipboardIcon, title: "Copy query", onClick: () => copyText(block.query) }]
      : []),
    {
      icon: IconBraces,
      title: "Copy JSON",
      disabled: !hasRows,
      onClick: () => copyRowsAsJSON(rows),
    },
    {
      icon: IconFileTypeCsv,
      title: "Copy CSV",
      disabled: !hasRows,
      onClick: () => copyRowsAsCSV(rows, columnsFromRows(rows)),
    },
  ];

  const chart = errorMessage ? (
    <ChartErrorMessage message={errorMessage} />
  ) : (
    <MetricChart
      rows={chartPoints}
      series={series}
      kind={block.chartType}
      xColumn={block.xAxisColumn}
      stacked={block.stacked ?? false}
      state={state}
      valueFormat={valueFormat}
      timeRange={timeRange}
    />
  );

  // groupByColumn caps at MAX_SERIES groups (readability, not a real limit on the data) — say so,
  // rather than silently dropping the rest.
  const truncationNotice =
    totalSeriesCount > series.length ? (
      <p className="shrink-0 px-1 pt-1 text-xs text-text-dimmed">
        Showing {series.length} of {totalSeriesCount} series
      </p>
    ) : null;

  return (
    <ChartCard
      title={
        <span className="flex flex-col gap-1">
          {block.title}
          {series.length > 0 ? (
            <ChartCardLegend
              entries={series.map((s) => ({ key: s.key, color: s.color, label: s.label }))}
            />
          ) : null}
        </span>
      }
      ariaLabel={block.title ?? "Chart"}
      accessory={<AgentBlockToolsMenu tools={tools} />}
      fullscreenAccessory={<AgentBlockToolsMenu tools={tools} revealOnHover={false} />}
      footer={
        block.actions?.length ? <ChartActions actions={block.actions} onIntent={onIntent} /> : null
      }
      className="border-border-bright bg-background-dimmed"
      fullscreenChildren={
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">{chart}</div>
          {truncationNotice}
        </div>
      }
    >
      <div className="flex h-64 flex-col">
        <div className="min-h-0 flex-1">{chart}</div>
        {truncationNotice}
      </div>
    </ChartCard>
  );
}

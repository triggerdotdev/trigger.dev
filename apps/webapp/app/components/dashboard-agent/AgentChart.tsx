import type { OutputColumnMetadata } from "@internal/clickhouse";
import type { ChartBlock } from "@internal/dashboard-agent";
import { useEffect, useState } from "react";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import type { ChartConfiguration } from "~/components/metrics/QueryWidget";
import { Spinner } from "~/components/primitives/Spinner";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";

// Render an agent "chart" block by running its TRQL query through the dashboard's
// own /resources/metric endpoint (session-authed, returns rows + real column
// metadata) and feeding the result into QueryResultsChart. So the chart is live
// and matches the Query page exactly: the agent only emits the query + chart
// config, never the rows. Runs against the project/env the panel is open in.

type MetricResponse =
  | { success: false; error: string }
  | {
      success: true;
      data: {
        rows: Record<string, unknown>[];
        columns: OutputColumnMetadata[];
        timeRange: { from: string; to: string };
      };
    };

// The chart block's schema (`chartBlockBodySchema` in
// @internal/dashboard-agent-contracts) carries only `period` for the time window
// — no scope, no explicit from/to, no height. So these are fixed here rather
// than plumbed from the block. If the schema grows those fields, read them off
// `block` instead of using these.
const CHART_SCOPE = "environment"; // the panel is always open in one environment
const CHART_FROM = null; // `period` is the only window the agent can ask for
const CHART_TO = null;
const CHART_HEIGHT_CLASS = "h-64"; // fits the panel at its default width

// Query errors come from ClickHouse via the metric endpoint and can carry SQL
// and schema detail, so the panel shows a fixed message and the real one goes to
// the console for whoever is debugging.
const CHART_ERROR_MESSAGE = "This chart's query couldn't run.";

type ChartState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      rows: Record<string, unknown>[];
      columns: OutputColumnMetadata[];
      timeRange?: { from: string; to: string };
    };

export function AgentChart({ block }: { block: ChartBlock }) {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  const [state, setState] = useState<ChartState>({ status: "loading" });

  const organizationId = organization?.id;
  const projectId = project?.id;
  const environmentId = environment?.id;

  useEffect(() => {
    // The block can render before its `query` has finished streaming in; wait
    // for it rather than POST an empty query (which 400s).
    if (!block.query) return;
    if (!organizationId || !projectId || !environmentId) {
      setState({ status: "error", error: "No environment context to run the query." });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch("/resources/metric", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: block.query,
        organizationId,
        projectId,
        environmentId,
        scope: CHART_SCOPE,
        period: block.period ?? null,
        from: CHART_FROM,
        to: CHART_TO,
      }),
      signal: controller.signal,
    })
      .then(async (res) => (await res.json()) as MetricResponse)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data.success) {
          console.error("Dashboard agent chart query failed:", data.error);
          setState({ status: "error", error: CHART_ERROR_MESSAGE });
        } else {
          setState({
            status: "ready",
            rows: data.data.rows,
            columns: data.data.columns,
            timeRange: data.data.timeRange,
          });
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error("Dashboard agent chart request failed:", err);
        setState({ status: "error", error: CHART_ERROR_MESSAGE });
      });
    return () => controller.abort();
  }, [block.query, block.period, organizationId, projectId, environmentId]);

  const config: ChartConfiguration = {
    chartType: block.chartType,
    xAxisColumn: block.xAxisColumn,
    yAxisColumns: block.yAxisColumns ?? [],
    groupByColumn: block.groupByColumn ?? null,
    stacked: block.stacked ?? false,
    sortByColumn: null,
    sortDirection: "desc",
    aggregation: block.aggregation ?? "sum",
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      {block.title ? (
        <div className="border-b border-grid-bright bg-background-bright px-3 py-2 text-xs font-medium text-text-dimmed">
          {block.title}
        </div>
      ) : null}
      <div className={cn("w-full p-2", CHART_HEIGHT_CLASS)}>
        {state.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-text-dimmed">
            <Spinner className="size-3" />
            Running query…
          </div>
        ) : state.status === "error" ? (
          <div className="flex h-full items-center justify-center px-3 text-center text-xs text-error">
            {state.error}
          </div>
        ) : (
          <QueryResultsChart
            rows={state.rows}
            columns={state.columns}
            config={config}
            timeRange={state.timeRange}
          />
        )}
      </div>
    </div>
  );
}

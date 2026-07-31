import type { OutputColumnMetadata } from "@internal/clickhouse";
import type { ChartBlock } from "@internal/dashboard-agent";
import {
  isTriggerUri,
  type AgentIntent,
  type ChartAction,
} from "@internal/dashboard-agent-contracts";
import { useEffect, useState } from "react";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import type { ChartConfiguration } from "~/components/metrics/QueryWidget";
import { Button } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { ChatActionsRow } from "./chat-layout";

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
// Fits the panel at its default width. `min-h-*` alongside the fixed height on
// purpose: the chart measures its own container and draws nothing at zero
// height, so a flex parent that squeezes the row (a card in a short turn, a
// narrow panel) must not be able to collapse it below this.
const CHART_HEIGHT_CLASS = "h-64 min-h-64";
// Top padding inside the plot area. The chart's own top gridline/label sits
// right on the container edge, so without this it touches the card header.
const CHART_PADDING_CLASS = "px-2 pb-2 pt-4";
/** The plot area's geometry, exported so the demo card can't drift from it. */
export const AGENT_CHART_PLOT_CLASS = `w-full ${CHART_PADDING_CLASS} ${CHART_HEIGHT_CLASS}`;

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

/**
 * The buttons under a ranking chart: act on the item the chart put on top.
 *
 * A card never navigates or asks on its own — it hands the block's intent to the
 * host, which submits an `ask` as the user's next message and resolves a
 * `navigate` before moving. Without an `onIntent` there is nothing to hand it to,
 * so the row isn't rendered rather than showing dead buttons.
 */
export function ChartActions({
  actions,
  onIntent,
}: {
  actions: ChartAction[];
  onIntent?: (intent: AgentIntent) => void;
}) {
  // A chart action's navigate target is a plain string at the contract boundary
  // (the model may hold no canonical URI) — only targets that really parse
  // become buttons, so a hallucinated URI costs a button, never a dead click.
  const renderable = actions.filter(
    (action) => action.intent.kind !== "navigate" || isTriggerUri(action.intent.target)
  );
  if (!onIntent || renderable.length === 0) return null;
  return (
    <div className="border-t border-grid-bright px-2 pb-2 pt-2">
      <ChatActionsRow>
        {renderable.map((action, i) => (
          <Button
            key={i}
            // The first action is the one to take; the rest are alternatives.
            variant={i === 0 ? "primary/small" : "secondary/small"}
            onClick={() => onIntent(action.intent as AgentIntent)}
          >
            {action.label}
          </Button>
        ))}
      </ChatActionsRow>
    </div>
  );
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
        userAuthoredQuery: true,
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
      <div className={cn(AGENT_CHART_PLOT_CLASS)}>
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
      <ChartActions actions={block.actions ?? []} onIntent={onIntent} />
    </div>
  );
}

import type { OutputColumnMetadata } from "@internal/clickhouse";
import type { ChartBlock } from "@internal/dashboard-agent";
import type { AgentIntent, ChartAction } from "@internal/dashboard-agent-contracts";
import { useEffect, useState } from "react";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import type { ChartConfiguration } from "~/components/metrics/QueryWidget";
import { Button } from "~/components/primitives/Buttons";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { AgentCard, AgentCardHeader } from "./agent-card";
import { ChatActionsRow } from "./chat-layout";
import { renderableActions } from "./view-actions";

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

// `chartBlockBodySchema` carries only `period`, so scope and from/to are fixed here.
const CHART_SCOPE = "environment";
const CHART_FROM = null;
const CHART_TO = null;
// `min-h` as well: the chart draws nothing at zero height if a flex parent collapses it.
const CHART_HEIGHT_CLASS = "h-64 min-h-64";
const CHART_PADDING_CLASS = "px-2 pb-2 pt-4";
export const AGENT_CHART_PLOT_CLASS = `w-full ${CHART_PADDING_CLASS} ${CHART_HEIGHT_CLASS}`;

// Query errors can carry SQL and schema detail, so the real one only goes to the console.
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
    <div className="border-t border-grid-bright px-2 pb-2 pt-2">
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
    // The block can render before `query` has streamed in; an empty query 400s.
    if (!block.query) return;
    if (!organizationId || !projectId || !environmentId) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
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
    <AgentCard>
      {block.title ? (
        <AgentCardHeader className="text-xs font-medium text-text-dimmed">
          {block.title}
        </AgentCardHeader>
      ) : null}
      <div className={cn(AGENT_CHART_PLOT_CLASS)}>
        {state.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-text-dimmed">
            <AgentSpinner size={12} />
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
    </AgentCard>
  );
}

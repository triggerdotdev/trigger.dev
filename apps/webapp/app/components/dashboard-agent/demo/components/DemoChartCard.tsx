import type { AgentIntent, ChartAction } from "@internal/dashboard-agent-contracts";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { AGENT_CHART_PLOT_CLASS, ChartActions } from "../../AgentChart";
import { demoChart } from "../fixtures/chart";

export function DemoChartCard({
  title = demoChart.title,
  actions,
  onIntent,
}: {
  title?: string;
  actions?: ChartAction[];
  onIntent?: (intent: AgentIntent) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      {title ? (
        <div className="border-b border-grid-bright bg-background-bright px-3 py-2 text-xs font-medium text-text-dimmed">
          {title}
        </div>
      ) : null}
      <div className={AGENT_CHART_PLOT_CLASS}>
        <QueryResultsChart
          rows={demoChart.rows}
          columns={demoChart.columns}
          config={demoChart.config}
          timeRange={demoChart.timeRange}
        />
      </div>
      <ChartActions actions={actions ?? []} onIntent={onIntent} />
    </div>
  );
}

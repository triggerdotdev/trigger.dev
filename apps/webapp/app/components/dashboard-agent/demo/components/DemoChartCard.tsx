import type { AgentIntent, ChartAction } from "@internal/dashboard-agent-contracts";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { AGENT_CHART_PLOT_CLASS, ChartActions } from "../../AgentChart";
import { AgentCard, AgentCardHeader } from "../../agent-card";
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
    <AgentCard>
      {title ? (
        <AgentCardHeader className="text-xs font-medium text-text-dimmed">{title}</AgentCardHeader>
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
    </AgentCard>
  );
}

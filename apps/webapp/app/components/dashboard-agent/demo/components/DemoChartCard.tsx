/**
 * A chart block rendered from canned rows. The real `AgentChart` fetches
 * `/resources/metric`; demo mode does no network, so this hands the same
 * `QueryResultsChart` the fixture rows directly. The frame mirrors `AgentChart` so
 * the card reads identically in the panel.
 */
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
  /** The row under the chart, when this chart ranks something. */
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

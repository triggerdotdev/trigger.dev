/**
 * A chart block, rendered from canned rows.
 *
 * The real `AgentChart` fetches `/resources/metric` to turn a block's TRQL into
 * rows. Demo mode does no network, so this hands the same `QueryResultsChart`
 * the fixture rows directly. The frame (border, title strip, height) mirrors
 * `AgentChart` so the card reads identically in the panel.
 */
import type { AgentIntent, ChartAction } from "@internal/dashboard-agent-contracts";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { ChartActions } from "../../AgentChart";
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
      <div className="h-64 w-full p-2">
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

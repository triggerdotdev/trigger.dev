/**
 * A chart block, rendered from canned rows.
 *
 * The real `AgentChart` fetches `/resources/metric` to turn a block's TRQL into
 * rows. Demo mode does no network, so this hands the same `QueryResultsChart`
 * the fixture rows directly.
 *
 * The frame comes from the report skin so a chart and a report read as siblings
 * in the same transcript: same near-black surface, same monospace title line.
 * Only the padding differs — a chart wants the width.
 */
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { ReportCommandLine, ReportSurface } from "../../report-skin";
import { demoChart } from "../fixtures/chart";

export function DemoChartCard({ title = demoChart.title }: { title?: string }) {
  return (
    <ReportSurface className="p-2">
      {title ? <ReportCommandLine>{title}</ReportCommandLine> : null}
      <div className="h-64 w-full">
        <QueryResultsChart
          rows={demoChart.rows}
          columns={demoChart.columns}
          config={demoChart.config}
          timeRange={demoChart.timeRange}
        />
      </div>
    </ReportSurface>
  );
}

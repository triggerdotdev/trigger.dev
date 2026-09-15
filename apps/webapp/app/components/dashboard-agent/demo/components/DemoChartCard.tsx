import type { AgentIntent, ChartAction } from "@internal/dashboard-agent-contracts";
import { useMemo } from "react";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { ChartCardLegend } from "~/components/primitives/charts/ChartCardLegend";
import { MetricChart } from "~/components/primitives/charts/MetricChart";
import { seriesFromRows } from "~/components/primitives/charts/seriesFromRows";
import { ChartActions } from "../../AgentChart";
import { demoChart } from "../fixtures/chart";

export function DemoChartCard({
  title = demoChart.title ?? undefined,
  actions,
  onIntent,
}: {
  title?: string;
  actions?: ChartAction[];
  onIntent?: (intent: AgentIntent) => void;
}) {
  const xAxisColumn = demoChart.config.xAxisColumn ?? "";
  const { points, series } = useMemo(
    () =>
      seriesFromRows(demoChart.rows, {
        xAxisColumn,
        yAxisColumns: demoChart.config.yAxisColumns,
        groupByColumn: demoChart.config.groupByColumn ?? undefined,
        aggregation: demoChart.config.aggregation,
      }),
    [xAxisColumn]
  );

  return (
    <ChartCard
      title={
        <span className="flex flex-col gap-1">
          {title}
          {series.length > 0 ? (
            <ChartCardLegend
              entries={series.map((s) => ({ key: s.key, color: s.color, label: s.label }))}
            />
          ) : null}
        </span>
      }
      footer={actions?.length ? <ChartActions actions={actions} onIntent={onIntent} /> : null}
      className="border-border-bright bg-background-dimmed"
    >
      <div className="h-64">
        <MetricChart
          rows={points}
          series={series}
          kind={demoChart.config.chartType}
          xColumn={xAxisColumn}
          stacked={demoChart.config.stacked}
        />
      </div>
    </ChartCard>
  );
}

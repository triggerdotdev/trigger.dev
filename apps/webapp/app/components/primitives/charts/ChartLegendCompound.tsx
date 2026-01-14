import React, { useMemo } from "react";
import { Legend } from "recharts";
import { ChartLegendContent, ChartLegendContentRows } from "./Chart";
import { useChartContext } from "./ChartContext";
import { useSeriesTotal } from "./ChartRoot";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";

export type ChartLegendCompoundProps = {
  /** Maximum number of legend items to show before collapsing */
  maxItems?: number;
  /** Use simple inline legend instead of row-based legend */
  simple?: boolean;
  /** Hide the legend entirely (useful for conditional rendering) */
  hidden?: boolean;
};

/**
 * Legend component for the chart compound system.
 * Automatically connects to chart context for highlighting.
 *
 * @example Simple legend
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Bar />
 *   <Chart.Legend />
 * </Chart.Root>
 * ```
 *
 * @example Row legend with max items
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Bar />
 *   <Chart.Legend maxItems={5} />
 * </Chart.Root>
 * ```
 */
export function ChartLegendCompound({
  maxItems = 5,
  simple = false,
  hidden = false,
}: ChartLegendCompoundProps) {
  const { config, dataKeys, highlight } = useChartContext();
  const totals = useSeriesTotal();

  // Get current data for the legend based on hover state
  const currentData = useMemo(() => {
    if (!highlight.activePayload?.length) return totals;

    // If we have activePayload data from hovering over a bar
    const hoverData = highlight.activePayload.reduce((acc, item) => {
      if (item.dataKey && item.value !== undefined) {
        acc[item.dataKey] = item.value;
      }
      return acc;
    }, {} as Record<string, number>);

    // Return a merged object - totals for keys not in the hover data
    return {
      ...totals,
      ...hoverData,
    };
  }, [highlight.activePayload, totals]);

  // Prepare legend payload with capped items
  const legendPayload = useMemo(() => {
    const allPayload = dataKeys.map((key) => ({
      dataKey: key,
      type: "rect" as const,
      color: config[key]?.color,
      value: key,
      payload: {} as any,
    }));

    if (allPayload.length <= maxItems) {
      return allPayload;
    }

    const visiblePayload = allPayload.slice(0, maxItems);
    const remainingCount = allPayload.length - maxItems;

    // If we're hovering over an item that's not visible in the legend,
    // add it as an extra item instead of showing the "view more" row
    if (
      highlight.activeBarKey &&
      !visiblePayload.some((item) => item.dataKey === highlight.activeBarKey)
    ) {
      const hoveredItem = allPayload.find((item) => item.dataKey === highlight.activeBarKey);
      if (hoveredItem) {
        return [...visiblePayload, hoveredItem];
      }
    }

    // Otherwise show the "view more" row
    return [
      ...visiblePayload,
      {
        dataKey: "view-more",
        type: "rect" as const,
        color: "transparent",
        value: "view-more",
        payload: { remainingCount },
      },
    ];
  }, [config, dataKeys, maxItems, highlight.activeBarKey]);

  if (hidden) {
    return null;
  }

  if (simple) {
    return <Legend content={<ChartLegendContent />} />;
  }

  return (
    <Legend
      content={
        <ChartLegendContentRows
          onMouseEnter={(data) => {
            if (data.dataKey === "view-more") return;
            highlight.setHoveredLegendItem(data.dataKey);
          }}
          onMouseLeave={highlight.reset}
          data={currentData}
          activeKey={highlight.activeBarKey}
          payload={legendPayload}
          renderViewMore={(remainingCount: number) => (
            <ViewAllDataRow key="view-more" remainingCount={remainingCount} />
          )}
        />
      }
      payload={legendPayload}
    />
  );
}

type ViewAllDataRowProps = {
  remainingCount: number;
};

function ViewAllDataRow({ remainingCount }: ViewAllDataRowProps) {
  return (
    <Button variant="minimal/small" fullWidth iconSpacing="justify-between" className="px-2 py-1">
      <div className="flex items-center gap-1.5 text-text-dimmed">
        <div className="h-3 w-1 rounded-[2px] border border-charcoal-600" />
        <Paragraph variant="extra-small" className="tabular-nums">
          {remainingCount} more…
        </Paragraph>
      </div>
      <Paragraph variant="extra-small" className="text-indigo-500">
        View all
      </Paragraph>
    </Button>
  );
}

import React, { useMemo } from "react";
import { useChartContext } from "./ChartContext";
import { useSeriesTotal } from "./ChartRoot";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";
import { cn } from "~/utils/cn";
import { AnimatedNumber } from "../AnimatedNumber";

export type ChartLegendCompoundProps = {
  /** Maximum number of legend items to show before collapsing */
  maxItems?: number;
  /** Hide the legend entirely (useful for conditional rendering) */
  hidden?: boolean;
  /** Additional className */
  className?: string;
};

/**
 * Legend component for the chart compound system.
 * Renders as a permanent element below the chart (not inside recharts).
 * Automatically connects to chart context for highlighting.
 *
 * @example Using via Chart.Root showLegend prop (recommended)
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day" showLegend maxLegendItems={5}>
 *   <Chart.Bar />
 * </Chart.Root>
 * ```
 */
export function ChartLegendCompound({
  maxItems = 5,
  hidden = false,
  className,
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

  // Prepare legend items with capped display
  const legendItems = useMemo(() => {
    const allItems = dataKeys.map((key) => ({
      dataKey: key,
      color: config[key]?.color,
      label: config[key]?.label ?? key,
    }));

    if (allItems.length <= maxItems) {
      return { visible: allItems, remaining: 0 };
    }

    const visibleItems = allItems.slice(0, maxItems);
    const remainingCount = allItems.length - maxItems;

    // If we're hovering over an item that's not visible in the legend,
    // add it as an extra item instead of showing the "view more" row
    if (
      highlight.activeBarKey &&
      !visibleItems.some((item) => item.dataKey === highlight.activeBarKey)
    ) {
      const hoveredItem = allItems.find((item) => item.dataKey === highlight.activeBarKey);
      if (hoveredItem) {
        return { visible: [...visibleItems, hoveredItem], remaining: remainingCount - 1 };
      }
    }

    return { visible: visibleItems, remaining: remainingCount };
  }, [config, dataKeys, maxItems, highlight.activeBarKey]);

  if (hidden || dataKeys.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-col pt-4", className)}>
      {legendItems.visible.map((item) => {
        const total = currentData[item.dataKey] ?? 0;
        const isActive = highlight.activeBarKey === item.dataKey;

        return (
          <div
            key={item.dataKey}
            className={cn(
              "relative flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 transition",
              total === 0 && "opacity-50"
            )}
            onMouseEnter={() => highlight.setHoveredLegendItem(item.dataKey)}
            onMouseLeave={() => highlight.reset()}
          >
            {/* Active highlight background */}
            {isActive && item.color && (
              <div
                className="absolute inset-0 rounded opacity-10"
                style={{ backgroundColor: item.color }}
              />
            )}
            <div className="relative flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {item.color && (
                  <div
                    className="h-3 w-1 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: item.color }}
                  />
                )}
                <span className={isActive ? "text-text-bright" : "text-text-dimmed"}>
                  {item.label}
                </span>
              </div>
              <span
                className={cn("tabular-nums", isActive ? "text-text-bright" : "text-text-dimmed")}
              >
                <AnimatedNumber value={total} duration={0.25} />
              </span>
            </div>
          </div>
        );
      })}

      {/* View more row */}
      {legendItems.remaining > 0 && <ViewAllDataRow remainingCount={legendItems.remaining} />}
    </div>
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

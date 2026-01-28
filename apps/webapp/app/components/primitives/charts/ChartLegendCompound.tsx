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
  /** Label for the total row */
  totalLabel?: string;
  /** Callback when "View all" button is clicked */
  onViewAllLegendItems?: () => void;
  /** When true, constrains legend to max 50% height with scrolling */
  scrollable?: boolean;
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
  maxItems = Infinity,
  hidden = false,
  className,
  totalLabel = "Total",
  onViewAllLegendItems,
  scrollable = false,
}: ChartLegendCompoundProps) {
  const { config, dataKey, dataKeys, highlight, labelFormatter } = useChartContext();
  const totals = useSeriesTotal();

  // Calculate grand total (sum of all series totals)
  const grandTotal = useMemo(() => {
    return dataKeys.reduce((sum, key) => sum + (totals[key] || 0), 0);
  }, [totals, dataKeys]);

  // Calculate current total based on hover state
  const currentTotal = useMemo(() => {
    if (!highlight.activePayload?.length) return grandTotal;

    // Sum all values from the hovered data point
    return highlight.activePayload.reduce((sum, item) => {
      if (item.value !== undefined && dataKeys.includes(item.dataKey as string)) {
        return sum + (Number(item.value) || 0);
      }
      return sum;
    }, 0);
  }, [highlight.activePayload, grandTotal, dataKeys]);

  // Get the label for the total row - x-axis value when hovering, totalLabel otherwise
  const currentTotalLabel = useMemo(() => {
    if (!highlight.activePayload?.length) return totalLabel;

    // Get the x-axis label from the payload's original data
    const firstPayloadItem = highlight.activePayload[0];
    const xAxisValue = firstPayloadItem?.payload?.[dataKey];

    if (xAxisValue === undefined) return totalLabel;

    // Apply the formatter if provided, otherwise just stringify the value
    const stringValue = String(xAxisValue);
    return labelFormatter ? labelFormatter(stringValue) : stringValue;
  }, [highlight.activePayload, dataKey, totalLabel, labelFormatter]);

  // Get current data for the legend based on hover state
  const currentData = useMemo(() => {
    if (!highlight.activePayload?.length) return totals;

    // If we have activePayload data from hovering over a bar
    const hoverData = highlight.activePayload.reduce((acc, item) => {
      if (item.dataKey && item.value !== undefined) {
        acc[item.dataKey] = Number(item.value) || 0;
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
      return { visible: allItems, remaining: 0, hoveredHiddenItem: undefined };
    }

    const visibleItems = allItems.slice(0, maxItems);
    const remainingCount = allItems.length - maxItems;

    // If we're hovering over an item that's not visible in the legend,
    // pass it separately to replace the "view more" row
    let hoveredHiddenItem: (typeof allItems)[0] | undefined;
    if (
      highlight.activeBarKey &&
      !visibleItems.some((item) => item.dataKey === highlight.activeBarKey)
    ) {
      hoveredHiddenItem = allItems.find((item) => item.dataKey === highlight.activeBarKey);
    }

    return { visible: visibleItems, remaining: remainingCount, hoveredHiddenItem };
  }, [config, dataKeys, maxItems, highlight.activeBarKey]);

  if (hidden || dataKeys.length === 0) {
    return null;
  }

  const isHovering = (highlight.activePayload?.length ?? 0) > 0;

  return (
    <div
      className={cn(
        "flex flex-col pt-4 text-sm",
        scrollable && "max-h-[50%] min-h-0",
        className
      )}
    >
      {/* Total row */}
      <div
        className={cn(
          "flex w-full shrink-0 items-center justify-between gap-2 rounded px-2 py-1 transition",
          isHovering ? "text-text-bright" : "text-text-dimmed"
        )}
      >
        <span className="font-medium">{currentTotalLabel}</span>
        <span className="font-medium tabular-nums">
          <AnimatedNumber value={currentTotal} duration={0.25} />
        </span>
      </div>

      {/* Separator */}
      <div className="mx-2 my-1 shrink-0 border-t border-charcoal-750" />

      {/* Legend items - scrollable when scrollable prop is true */}
      <div className={cn("flex flex-col", scrollable && "min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600")}>
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
              <div className="relative flex w-full items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {item.color && (
                    <div
                      className="w-1 shrink-0 self-stretch rounded-[2px]"
                      style={{ backgroundColor: item.color }}
                    />
                  )}
                  <span className={isActive ? "text-text-bright" : "text-text-dimmed"}>
                    {item.label}
                  </span>
                </div>
                <span
                  className={cn(
                    "self-start tabular-nums",
                    isActive ? "text-text-bright" : "text-text-dimmed"
                  )}
                >
                  <AnimatedNumber value={total} duration={0.25} />
                </span>
              </div>
            </div>
          );
        })}

        {/* View more row - replaced by hovered hidden item when applicable */}
        {legendItems.remaining > 0 &&
          (legendItems.hoveredHiddenItem ? (
            <HoveredHiddenItemRow
              item={legendItems.hoveredHiddenItem}
              value={currentData[legendItems.hoveredHiddenItem.dataKey] ?? 0}
              remainingCount={legendItems.remaining - 1}
            />
          ) : (
            <ViewAllDataRow remainingCount={legendItems.remaining} onViewAll={onViewAllLegendItems} />
          ))}
      </div>
    </div>
  );
}

type ViewAllDataRowProps = {
  remainingCount: number;
  onViewAll?: () => void;
};

function ViewAllDataRow({ remainingCount, onViewAll }: ViewAllDataRowProps) {
  return (
    <Button
      variant="minimal/small"
      fullWidth
      iconSpacing="justify-between"
      className="px-2 py-1"
      onClick={onViewAll}
    >
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

type HoveredHiddenItemRowProps = {
  item: { dataKey: string; color?: string; label: React.ReactNode };
  value: number;
  remainingCount: number;
};

function HoveredHiddenItemRow({ item, value, remainingCount }: HoveredHiddenItemRowProps) {
  return (
    <div className="relative flex w-full items-center justify-between gap-2 rounded px-2 py-1">
      {/* Active highlight background */}
      {item.color && (
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
          <span className="text-text-bright">{item.label}</span>
          {remainingCount > 0 && <span className="text-text-dimmed">+{remainingCount} more</span>}
        </div>
        <span className="tabular-nums text-text-bright">
          <AnimatedNumber value={value} duration={0.25} />
        </span>
      </div>
    </div>
  );
}

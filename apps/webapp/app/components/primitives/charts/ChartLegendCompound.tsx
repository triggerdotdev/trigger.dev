import React, { useMemo } from "react";
import type { AggregationType } from "~/components/metrics/QueryWidget";
import { useActivePayload, useChartContext } from "./ChartContext";
import { useSeriesTotal } from "./ChartRoot";
import { aggregateValues } from "./aggregation";
import { cn } from "~/utils/cn";
import { AnimatedNumber } from "../AnimatedNumber";
import { SimpleTooltip } from "../Tooltip";

const aggregationLabels: Record<AggregationType, string> = {
  sum: "Sum",
  avg: "Average",
  count: "Count",
  min: "Min",
  max: "Max",
};

export type ChartLegendCompoundProps = {
  /** Maximum number of legend items to show before collapsing */
  maxItems?: number;
  /** Hide the legend entirely (useful for conditional rendering) */
  hidden?: boolean;
  /** Additional className */
  className?: string;
  /** Label for the total row (derived from aggregation when not provided) */
  totalLabel?: string;
  /** Aggregation method – controls the header label and how totals are computed */
  aggregation?: AggregationType;
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
  totalLabel,
  aggregation,
  onViewAllLegendItems,
  scrollable = false,
}: ChartLegendCompoundProps) {
  const { config, dataKey, dataKeys, highlight, labelFormatter } = useChartContext();
  const activePayload = useActivePayload();
  const totals = useSeriesTotal(aggregation);

  // Derive the effective label from the aggregation type when no explicit label is provided
  const effectiveTotalLabel = totalLabel ?? (aggregation ? aggregationLabels[aggregation] : "Total");

  // Calculate grand total by aggregating across all per-series values
  const grandTotal = useMemo(() => {
    const values = dataKeys.map((key) => totals[key] || 0);
    if (!aggregation) {
      // Default: sum
      return values.reduce((a, b) => a + b, 0);
    }
    return aggregateValues(values, aggregation);
  }, [totals, dataKeys, aggregation]);

  // Calculate current total based on hover state (null when hovering a gap-filled point)
  const currentTotal = useMemo((): number | null => {
    if (!activePayload?.length) return grandTotal;

    // Use the full data row so the total covers ALL dataKeys, not just visibleSeries
    const dataRow = activePayload[0]?.payload;
    if (!dataRow) return grandTotal;

    const rawValues = dataKeys.map((key) => dataRow[key]);

    const values = rawValues
      .filter((v): v is number => v != null)
      .map((v) => Number(v) || 0);

    // All null → gap-filled point, return null to show dash
    if (values.length === 0) return null;

    if (!aggregation) {
      return values.reduce((a, b) => a + b, 0);
    }
    return aggregateValues(values, aggregation);
  }, [activePayload, grandTotal, dataKeys, aggregation]);

  // Get the label for the total row - x-axis value when hovering, effectiveTotalLabel otherwise
  const currentTotalLabel = useMemo(() => {
    if (!activePayload?.length) return effectiveTotalLabel;

    // Get the x-axis label from the payload's original data
    const firstPayloadItem = activePayload[0];
    const xAxisValue = firstPayloadItem?.payload?.[dataKey];

    if (xAxisValue === undefined) return effectiveTotalLabel;

    // Apply the formatter if provided, otherwise just stringify the value
    const stringValue = String(xAxisValue);
    return labelFormatter ? labelFormatter(stringValue) : stringValue;
  }, [activePayload, dataKey, effectiveTotalLabel, labelFormatter]);

  // Get current data for the legend based on hover state (values may be null for gap-filled points)
  const currentData = useMemo((): Record<string, number | null> => {
    if (!activePayload?.length) return totals;

    // Use the full data row so ALL dataKeys are resolved from the hovered point,
    // not just the visibleSeries present in activePayload.
    const dataRow = activePayload[0]?.payload;
    if (!dataRow) return totals;

    const hoverData: Record<string, number | null> = {};
    for (const key of dataKeys) {
      const value = dataRow[key];
      if (value !== undefined) {
        hoverData[key] = value != null ? Number(value) || 0 : null;
      }
    }

    return {
      ...totals,
      ...hoverData,
    };
  }, [activePayload, totals, dataKeys]);

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

  const isHovering = (activePayload?.length ?? 0) > 0;

  return (
    <div
      className={cn("flex flex-col px-2 pb-2 pt-4 text-sm", scrollable && "max-h-[50%] min-h-0", className)}
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
          {currentTotal != null ? (
            <AnimatedNumber value={currentTotal} duration={0.25} />
          ) : (
            "\u2013"
          )}
        </span>
      </div>

      {/* Separator */}
      <div className="mx-2 my-1 shrink-0 border-t border-charcoal-750" />

      {/* Legend items - scrollable when scrollable prop is true */}
      <div
        className={cn(
          "flex flex-col",
          scrollable &&
            "min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        )}
      >
        {legendItems.visible.map((item) => {
          const total = currentData[item.dataKey] ?? null;
          const isActive = highlight.activeBarKey === item.dataKey;

          return (
            <div
              key={item.dataKey}
              className={cn(
                "relative flex w-full cursor-default items-center justify-between gap-2 rounded px-2 py-1 transition",
                (total == null || total === 0) && "opacity-50"
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
              <div className="relative flex w-full items-center justify-between gap-3 overflow-hidden">
                <SimpleTooltip
                  button={
                    <div className="flex min-w-0 items-center gap-1.5">
                      {item.color && (
                        <div
                          className="w-1 shrink-0 self-stretch rounded-[2px]"
                          style={{ backgroundColor: item.color }}
                        />
                      )}
                      <span
                        className={cn(
                          "truncate",
                          isActive ? "text-text-bright" : "text-text-dimmed"
                        )}
                      >
                        {item.label}
                      </span>
                    </div>
                  }
                  content={item.label}
                  side="top"
                  disableHoverableContent
                  className="max-w-xs break-words"
                  buttonClassName="cursor-default min-w-0"
                />
                <span
                  className={cn(
                    "self-start tabular-nums",
                    isActive ? "text-text-bright" : "text-text-dimmed"
                  )}
                >
                  {total != null ? (
                    <AnimatedNumber value={total} duration={0.25} />
                  ) : (
                    "\u2013"
                  )}
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
              value={currentData[legendItems.hoveredHiddenItem.dataKey] ?? null}
              remainingCount={legendItems.remaining - 1}
            />
          ) : (
            <ViewAllDataRow
              remainingCount={legendItems.remaining}
              onViewAll={onViewAllLegendItems}
            />
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
    <div
      className="relative flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 transition hover:bg-charcoal-850"
      onClick={onViewAll}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onViewAll?.();
        }
      }}
    >
      <div className="relative flex w-full items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-1 shrink-0 self-stretch rounded-[2px] border border-charcoal-600" />
          <span className="text-text-dimmed tabular-nums">{remainingCount} more…</span>
        </div>
        <span className="self-start text-indigo-500">View all</span>
      </div>
    </div>
  );
}

type HoveredHiddenItemRowProps = {
  item: { dataKey: string; color?: string; label: React.ReactNode };
  value: number | null;
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
      <div className="relative flex w-full items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {item.color && (
            <div
              className="w-1 shrink-0 self-stretch rounded-[2px]"
              style={{ backgroundColor: item.color }}
            />
          )}
          <span className="text-text-bright">{item.label}</span>
          {remainingCount > 0 && <span className="text-text-dimmed">+{remainingCount} more</span>}
        </div>
        <span className="tabular-nums text-text-bright">
          {value != null ? <AnimatedNumber value={value} duration={0.25} /> : "\u2013"}
        </span>
      </div>
    </div>
  );
}

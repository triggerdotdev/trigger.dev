import React, { useCallback } from "react";
import { ReferenceArea, ReferenceLine } from "recharts";
import { useChartContext } from "./ChartContext";
import { useDateRange } from "./DateRangeContext";
import { cn } from "~/utils/cn";

export type ChartZoomProps = {
  /** Sync zoom with DateRangeContext (for dashboard-level syncing) */
  syncWithDateRange?: boolean;
  /** Minimum number of data points required for a valid zoom selection */
  minDataPoints?: number;
};

/**
 * Zoom overlay component for charts.
 * Renders the zoom selection area and inspection line.
 *
 * Must be used within a Chart.Root with enableZoom={true}.
 *
 * @example Basic zoom
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day" enableZoom onZoomChange={handleZoom}>
 *   <Chart.Bar />
 *   <Chart.Zoom />
 * </Chart.Root>
 * ```
 *
 * @example Synced with DateRangeContext
 * ```tsx
 * <DateRangeProvider>
 *   <Chart.Root config={config} data={data} dataKey="day" enableZoom onZoomChange={handleZoom}>
 *     <Chart.Bar />
 *     <Chart.Zoom syncWithDateRange />
 *   </Chart.Root>
 * </DateRangeProvider>
 * ```
 */
export function ChartZoom({ syncWithDateRange = false, minDataPoints = 3 }: ChartZoomProps) {
  const { zoom, data, dataKey, onZoomChange } = useChartContext();
  const globalDateRange = useDateRange();

  if (!zoom) {
    console.warn("ChartZoom: zoom is not enabled. Add enableZoom to Chart.Root.");
    return null;
  }

  const { inspectionLine, refAreaLeft, refAreaRight } = zoom;

  return (
    <>
      {/* Inspection line (click to inspect) */}
      {inspectionLine && (
        <ReferenceLine
          x={inspectionLine}
          stroke="#D7D9DD"
          strokeWidth={2}
          isFront={true}
          onClick={(e: any) => {
            e?.stopPropagation?.();
            zoom.clearInspectionLine();
          }}
        />
      )}

      {/* Zoom selection area */}
      {refAreaLeft && refAreaRight && (
        <ReferenceArea
          x1={refAreaLeft}
          x2={refAreaRight}
          strokeOpacity={0.4}
          fill="#3B82F6"
          fillOpacity={0.2}
        />
      )}
    </>
  );
}

/**
 * Tooltip component for showing zoom selection feedback.
 * Can be used inside ChartTooltip content prop.
 *
 * Note: This component receives zoom state as props because recharts
 * may render tooltips outside the normal React tree where context isn't available.
 */
export type ZoomTooltipProps = {
  active?: boolean;
  payload?: any[];
  label?: string;
  viewBox?: {
    height: number;
    width: number;
  };
  coordinate?: {
    x: number;
    y: number;
  };
  // Zoom state passed as props (since context might not be available in tooltip)
  isSelecting?: boolean;
  refAreaLeft?: string | null;
  refAreaRight?: string | null;
  invalidSelection?: boolean;
};

export function ZoomTooltip({
  active,
  payload,
  label,
  viewBox,
  coordinate,
  isSelecting,
  refAreaLeft,
  refAreaRight,
  invalidSelection,
}: ZoomTooltipProps) {
  if (!active) return null;

  // Show zoom range when selecting
  if (isSelecting && refAreaLeft && refAreaRight) {
    const message = invalidSelection
      ? "Zoom: Drag a wider range"
      : `Zoom: ${refAreaLeft} to ${refAreaRight}`;

    return (
      <div
        className={cn(
          "absolute whitespace-nowrap rounded border px-2 py-1 text-xxs tabular-nums",
          invalidSelection
            ? "border-amber-800 bg-amber-950 text-amber-400"
            : "border-blue-800 bg-[#1B2334] text-blue-400"
        )}
        style={{
          left: coordinate?.x,
          top: viewBox?.height ? viewBox.height + 14 : 0,
          transform: "translateX(-50%)",
        }}
      >
        {message}
        <div
          className={cn(
            "absolute -top-[5px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45",
            invalidSelection
              ? "border-l border-t border-amber-800 bg-amber-950"
              : "border-l border-t border-blue-800 bg-[#1B2334]"
          )}
        />
      </div>
    );
  }

  // Default tooltip behavior (show label)
  if (!payload?.length) return null;

  return (
    <div
      className="absolute whitespace-nowrap rounded border border-charcoal-600 bg-charcoal-700 px-2 py-1 text-xxs tabular-nums text-text-bright"
      style={{
        left: coordinate?.x,
        top: viewBox?.height ? viewBox.height + 13 : 0,
        transform: "translateX(-50%)",
      }}
    >
      {label}
      <div className="absolute -top-[5px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t border-charcoal-600 bg-charcoal-700" />
    </div>
  );
}

/**
 * Hook that returns event handlers for zoom interactions.
 * Use these on your chart component (BarChart, LineChart, etc.).
 */
export function useZoomHandlers(
  options: { minDataPoints?: number; syncWithDateRange?: boolean } = {}
) {
  const { minDataPoints = 3, syncWithDateRange = false } = options;
  const { zoom, data, dataKey, onZoomChange } = useChartContext();
  const globalDateRange = useDateRange();

  const handleMouseDown = useCallback(
    (e: any) => {
      if (!zoom || !e?.activeLabel) return;
      zoom.startSelection(e.activeLabel);
    },
    [zoom]
  );

  const handleMouseMove = useCallback(
    (e: any) => {
      if (!zoom || !e?.activeLabel) return;
      if (zoom.isSelecting) {
        zoom.updateSelection(e.activeLabel, data, dataKey, minDataPoints);
      }
    },
    [zoom, data, dataKey, minDataPoints]
  );

  const handleMouseUp = useCallback(() => {
    if (!zoom) return;

    const range = zoom.finishSelection(data, dataKey, minDataPoints);

    if (range) {
      // If syncing with DateRangeContext, update it
      if (syncWithDateRange && globalDateRange) {
        globalDateRange.setDateRange(range.start, range.end);
      }

      // Call the onZoomChange callback
      onZoomChange?.(range);
    }
  }, [zoom, data, dataKey, minDataPoints, syncWithDateRange, globalDateRange, onZoomChange]);

  const handleClick = useCallback(
    (e: any) => {
      if (!zoom || zoom.isSelecting || !e?.activeLabel) return;
      zoom.toggleInspectionLine(e.activeLabel);
    },
    [zoom]
  );

  const handleMouseLeave = useCallback(() => {
    if (!zoom) return;
    zoom.cancelSelection();
  }, [zoom]);

  if (!zoom) {
    return {
      onMouseDown: undefined,
      onMouseMove: undefined,
      onMouseUp: undefined,
      onClick: undefined,
      onMouseLeave: undefined,
    };
  }

  return {
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
    onClick: handleClick,
    onMouseLeave: handleMouseLeave,
  };
}

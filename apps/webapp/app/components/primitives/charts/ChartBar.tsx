import React, { useCallback, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContentRows,
  ChartTooltip,
  type ChartState,
} from "~/components/primitives/charts/Chart";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";
import { ChartBarLoading, ChartNoData, ChartInvalid } from "./ChartLoading";
import { useDateRange } from "./DateRangeContext";
import { cn } from "~/utils/cn";

//TODO: fix the first and last bars in a stack not having rounded corners

type ReferenceLineProps = {
  value: number;
  label: string;
};

type ChartBarProps = {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  state?: ChartState;
  maxLegendItems?: number;
  referenceLine?: ReferenceLineProps;
  useGlobalDateRange?: boolean;
  minHeight?: string;
  stackId?: string;
};

type TooltipProps = {
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
  isSelecting: boolean;
  refAreaLeft: string | null;
  refAreaRight: string | null;
  invalidSelection: boolean;
};

export function ChartBar({
  config,
  data: initialData,
  dataKey,
  state,
  maxLegendItems = 5,
  referenceLine,
  useGlobalDateRange = false,
  minHeight,
  stackId,
}: ChartBarProps) {
  const globalDateRange = useDateRange();
  const [activePayload, setActivePayload] = React.useState<any[] | null>(null);
  const [activeBarKey, setActiveBarKey] = React.useState<string | null>(null);
  const [activeDataPointIndex, setActiveDataPointIndex] = React.useState<number | null>(null);
  const [tooltipActive, setTooltipActive] = React.useState(false);

  // New state for the inspection line
  const [inspectionLine, setInspectionLine] = React.useState<string | null>(null);

  // Zoom state (only used when not using global date range)
  const [refAreaLeft, setRefAreaLeft] = React.useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = React.useState<string | null>(null);
  const [localStartIndex, setLocalStartIndex] = React.useState<number>(0);
  const [localEndIndex, setLocalEndIndex] = React.useState<number>(initialData.length - 1);
  const [localOriginalData, setLocalOriginalData] = React.useState<any[]>(initialData);
  const [isSelecting, setIsSelecting] = React.useState(false);
  const [invalidSelection, setInvalidSelection] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const displayState = state;

  // Update local data when initialData changes and we're not using global
  React.useEffect(() => {
    if (!useGlobalDateRange) {
      setLocalOriginalData(initialData);
      setLocalStartIndex(0);
      setLocalEndIndex(initialData.length - 1);
    }
  }, [initialData, useGlobalDateRange]);

  // Compute the visible data based on the zoom settings
  const data = useMemo(() => {
    if (useGlobalDateRange) {
      // Filter data based on global date range
      // Check if we have valid chart data
      if (initialData.length === 0) return [];

      // Get a sorted list of all available day values
      const allDays = initialData
        .map((item) => item[dataKey] as string)
        .filter(Boolean)
        .sort();

      // Check if our date range is in the available dates
      const startDateIndex = allDays.findIndex((day) => day === globalDateRange.startDate);
      const endDateIndex = allDays.findIndex((day) => day === globalDateRange.endDate);

      // If we can't find the exact dates, just return all data
      if (startDateIndex === -1 || endDateIndex === -1) {
        console.warn(
          `Date range not found in data. Start: ${globalDateRange.startDate}, End: ${globalDateRange.endDate}`
        );
        console.log("Available dates:", allDays);
        return initialData;
      }

      // Filter to only include items within the range
      return initialData.filter((item) => {
        const itemDate = item[dataKey] as string;
        const itemIndex = allDays.indexOf(itemDate);
        // Include if the day is within the range (inclusive)
        return itemIndex >= startDateIndex && itemIndex <= endDateIndex;
      });
    } else {
      // Use local date range for individual chart zoom
      return localOriginalData.slice(localStartIndex, localEndIndex + 1);
    }
  }, [
    initialData,
    useGlobalDateRange,
    globalDateRange.startDate,
    globalDateRange.endDate,
    localOriginalData,
    localStartIndex,
    localEndIndex,
    dataKey,
  ]);

  // Check if all values in current visible range are zero or null
  const hasNoData = useMemo(() => {
    if (data.length === 0) return true;

    // Get all data keys except the x-axis key
    const valueKeys = Object.keys(config).filter((k) => k !== dataKey);

    // Check if all data points have zero or null values for all valueKeys
    return data.every((item) => {
      return valueKeys.every((key) => {
        const value = item[key];
        return value === 0 || value === null || value === undefined;
      });
    });
  }, [data, config, dataKey]);

  const dimmedOpacity = 0.2;

  // Calculate totals for each category
  const totals = useMemo(() => {
    return data.reduce((acc, item) => {
      Object.entries(item).forEach(([key, value]) => {
        if (key !== dataKey) {
          acc[key] = (acc[key] || 0) + (Number(value) || 0);
        }
      });
      return acc;
    }, {} as Record<string, number>);
  }, [data, dataKey]);

  // Get all data keys except the x-axis key
  const dataKeys = useMemo(
    () => Object.keys(config).filter((k) => k !== dataKey),
    [config, dataKey]
  );

  // Get current data for the legend based on hover state
  const currentData = useMemo(() => {
    if (!activePayload?.length) return totals;

    // If we have activePayload data from hovering over a bar
    const hoverData = activePayload.reduce((acc, item) => {
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
  }, [activePayload, totals]);

  // Reset all highlight states
  const resetHighlightState = useCallback(() => {
    setActiveBarKey(null);
    setActiveDataPointIndex(null);
    setActivePayload(null);
  }, []);

  // Prepare legend payload with capped items
  const legendPayload = useMemo(() => {
    const allPayload = dataKeys.map((key) => ({
      dataKey: key,
      type: "rect" as const,
      color: config[key].color,
      value: key,
      payload: {} as any,
    }));

    if (allPayload.length <= maxLegendItems) {
      return allPayload;
    }

    const visiblePayload = allPayload.slice(0, maxLegendItems);
    const remainingCount = allPayload.length - maxLegendItems;

    // If we're hovering over an item that's not visible in the legend,
    // add it as a 6th item instead of showing the "view more" row
    if (activeBarKey && !visiblePayload.some((item) => item.dataKey === activeBarKey)) {
      const hoveredItem = allPayload.find((item) => item.dataKey === activeBarKey);
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
  }, [config, dataKeys, maxLegendItems, activeBarKey]);

  // Handle mouse down for drag zooming
  const handleMouseDown = useCallback((e: any) => {
    if (e.activeLabel) {
      setRefAreaLeft(e.activeLabel);
      setIsSelecting(true);
    }
  }, []);

  // Handle click on the chart area
  const handleChartClick = useCallback(
    (e: any) => {
      // Only process if we're not in selection mode and have a valid click position
      if (!isSelecting && e?.activeLabel) {
        // Toggle the inspection line - if clicking the same point, remove it; otherwise, set a new one
        if (inspectionLine === e.activeLabel) {
          setInspectionLine(null);
        } else {
          setInspectionLine(e.activeLabel);
        }
      }
    },
    [isSelecting, inspectionLine]
  );

  // Handle mouse move for drag zooming
  const handleMouseMove = useCallback(
    (e: any) => {
      // Handle both selection and active payload update
      if (isSelecting && e?.activeLabel) {
        setRefAreaRight(e.activeLabel);

        // Check if selection is likely to be too small
        if (refAreaLeft) {
          // Get indices from original data
          const dataArray = useGlobalDateRange ? initialData : localOriginalData;
          const allDays = dataArray.map((item) => item[dataKey] as string).filter(Boolean);

          const leftIndex = allDays.indexOf(refAreaLeft);
          const rightIndex = allDays.indexOf(e.activeLabel);

          if (leftIndex !== -1 && rightIndex !== -1) {
            const [start, end] = [leftIndex, rightIndex].sort((a, b) => a - b);

            // Mark as invalid if the selection is too small (less than 3 data points)
            setInvalidSelection(end - start < 2);
          } else {
            setInvalidSelection(true);
          }
        }
      }

      // Update active payload for legend
      if (e?.activePayload?.length) {
        setActivePayload(e.activePayload);
        setTooltipActive(true);
      } else {
        setTooltipActive(false);
      }
    },
    [isSelecting, refAreaLeft, useGlobalDateRange, initialData, localOriginalData, dataKey]
  );

  // Handle mouse up for drag zooming
  const handleMouseUp = useCallback(() => {
    if (refAreaLeft && refAreaRight) {
      // If global date range, update the context
      if (useGlobalDateRange) {
        // Get indices from original data
        const allDays = initialData.map((item) => item[dataKey] as string).filter(Boolean);

        const leftIndex = allDays.indexOf(refAreaLeft);
        const rightIndex = allDays.indexOf(refAreaRight);

        if (leftIndex !== -1 && rightIndex !== -1) {
          const [start, end] = [leftIndex, rightIndex].sort((a, b) => a - b);

          // Only update if selection is valid (at least 3 data points)
          if (end - start >= 2) {
            // Get the actual date values at these sorted indexes
            const startDate = allDays[start];
            const endDate = allDays[end];

            // Set the global date range using these ordered dates
            globalDateRange.setDateRange(startDate, endDate);
          }
        }
      } else {
        // Get indices of the selected range for local zoom
        const leftIndex = localOriginalData.findIndex((item) => item[dataKey] === refAreaLeft);
        const rightIndex = localOriginalData.findIndex((item) => item[dataKey] === refAreaRight);

        // Ensure left is less than right
        const [start, end] = [leftIndex, rightIndex].sort((a, b) => a - b);

        // Check if the selection is too small (less than 3 data points)
        if (end - start < 2) {
          // Don't update the range if it's too small
        } else {
          // Update the start and end indices
          if (start !== -1 && end !== -1) {
            setLocalStartIndex(start);
            setLocalEndIndex(end);
          }
        }
      }
    }

    setRefAreaLeft(null);
    setRefAreaRight(null);
    setIsSelecting(false);
    setInvalidSelection(false);
  }, [
    refAreaLeft,
    refAreaRight,
    useGlobalDateRange,
    initialData,
    localOriginalData,
    dataKey,
    globalDateRange,
  ]);

  // Handle bar stack click for inspection line
  const handleBarClick = useCallback(
    (barData: any, e: React.MouseEvent) => {
      // Prevent the event from propagating to the chart's onClick handler
      e.stopPropagation();

      // Only process clicks if we're not in selection mode
      if (!isSelecting) {
        // Toggle the inspection line - if clicking the same point, remove it; otherwise, set a new one
        if (inspectionLine === barData[dataKey]) {
          setInspectionLine(null);
        } else {
          setInspectionLine(barData[dataKey]);
        }
      }
    },
    [isSelecting, inspectionLine, dataKey]
  );

  // Render appropriate content based on displayState
  const renderChartContent = useCallback(() => {
    if (displayState === "loading") {
      return <ChartBarLoading />;
    } else if (displayState === "noData" || hasNoData) {
      return <ChartNoData />;
    } else if (displayState === "invalid") {
      return <ChartInvalid />;
    }

    // Get the x-axis ticks based on tooltip state
    const xAxisTicks =
      tooltipActive && data.length > 2
        ? [data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]
        : undefined;

    return (
      <BarChart
        data={data}
        barCategoryGap={1}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleChartClick}
        onMouseLeave={() => {
          handleMouseUp();
          resetHighlightState();
          setTooltipActive(false);
        }}
      >
        <CartesianGrid vertical={false} stroke="#272A2E" />
        <XAxis
          dataKey={dataKey}
          tickLine={false}
          tickMargin={10}
          axisLine={false}
          ticks={xAxisTicks}
          interval="preserveStartEnd"
          tick={{
            fill: "#878C99",
            fontSize: 11,
            style: { fontVariantNumeric: "tabular-nums" },
          }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={8}
          tick={{
            fill: "#878C99",
            fontSize: 11,
            style: { fontVariantNumeric: "tabular-nums" },
          }}
          domain={["auto", (dataMax: number) => dataMax * 1.15]}
        />
        <ChartTooltip
          cursor={{ fill: "#2C3034" }}
          content={
            <XAxisTooltip
              isSelecting={isSelecting}
              refAreaLeft={refAreaLeft}
              refAreaRight={refAreaRight}
              invalidSelection={invalidSelection}
            />
          }
          allowEscapeViewBox={{ x: false, y: true }}
        />
        {dataKeys.map((key, index, array) => {
          return (
            <Bar
              key={key}
              dataKey={key}
              stackId={stackId}
              fill={config[key].color}
              radius={
                [
                  index === array.length - 1 ? 2 : 0,
                  index === array.length - 1 ? 2 : 0,
                  index === 0 ? 2 : 0,
                  index === 0 ? 2 : 0,
                ] as [number, number, number, number]
              }
              activeBar={false}
              fillOpacity={1}
              onClick={(data, index, e) => handleBarClick(data, e)}
              onMouseEnter={(entry, index) => {
                if (entry.tooltipPayload?.[0]) {
                  const { dataKey: hoveredKey } = entry.tooltipPayload[0];
                  setActiveBarKey(hoveredKey);
                  setActiveDataPointIndex(index);
                }
              }}
              onMouseLeave={resetHighlightState}
              isAnimationActive={false}
            >
              {data.map((_, dataIndex) => {
                let opacity = 1;

                // Only apply dimming if we're not in zoom selection mode
                if (!isSelecting) {
                  // Hovering a specific bar
                  if (activeBarKey !== null && activeDataPointIndex !== null) {
                    // Only show full opacity for the exact bar being hovered
                    opacity =
                      key === activeBarKey && dataIndex === activeDataPointIndex
                        ? 1
                        : dimmedOpacity;
                  }
                  // Hovering a legend item
                  else if (activeBarKey !== null && activeDataPointIndex === null) {
                    // Show all bars of this type with full opacity
                    opacity = key === activeBarKey ? 1 : dimmedOpacity;
                  }
                }

                return (
                  <Cell
                    key={`cell-${key}-${dataIndex}`}
                    fill={config[key].color}
                    fillOpacity={opacity}
                  />
                );
              })}
            </Bar>
          );
        })}
        {referenceLine && (
          <ReferenceLine
            y={referenceLine.value}
            label={{
              position: "top",
              value: referenceLine.label,
              fill: "#878C99",
              fontSize: 11,
            }}
            isFront={true}
            stroke="#3B3E45"
            strokeDasharray="4 4"
            className="pointer-events-none"
          />
        )}

        {inspectionLine && (
          <ReferenceLine
            x={inspectionLine}
            stroke="#D7D9DD"
            strokeWidth={2}
            isFront={true}
            onClick={(e) => {
              e.stopPropagation();
              setInspectionLine(null);
            }}
          />
        )}

        {refAreaLeft && refAreaRight && (
          <ReferenceArea
            x1={refAreaLeft}
            x2={refAreaRight}
            strokeOpacity={0.4}
            fill="#3B82F6"
            fillOpacity={0.2}
          />
        )}

        <ChartLegend
          content={
            <ChartLegendContentRows
              onMouseEnter={(data) => {
                if (data.dataKey === "view-more") return;
                setActiveBarKey(data.dataKey);
                setActiveDataPointIndex(null); // Reset this when hovering over legend
              }}
              onMouseLeave={resetHighlightState}
              data={currentData}
              activeKey={activeBarKey}
              payload={legendPayload}
              renderViewMore={(remainingCount: number) => (
                <ViewAllDataRow key="view-more" remainingCount={remainingCount} />
              )}
            />
          }
          payload={legendPayload}
        />
      </BarChart>
    );
  }, [
    displayState,
    hasNoData,
    tooltipActive,
    data,
    dataKey,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleChartClick,
    resetHighlightState,
    dataKeys,
    config,
    stackId,
    handleBarClick,
    activeBarKey,
    activeDataPointIndex,
    isSelecting,
    dimmedOpacity,
    referenceLine,
    inspectionLine,
    refAreaLeft,
    refAreaRight,
    legendPayload,
    currentData,
  ]);

  return (
    <div className="relative flex w-full flex-col">
      <div
        ref={containerRef}
        className="mt-8 h-full w-full cursor-crosshair"
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer
          config={config}
          className={cn(
            "h-full w-full [&_.recharts-surface]:cursor-crosshair [&_.recharts-wrapper]:cursor-crosshair"
          )}
          style={minHeight ? { minHeight } : undefined}
        >
          {renderChartContent()}
        </ChartContainer>
      </div>
    </div>
  );
}

const XAxisTooltip = ({
  active,
  payload,
  label,
  viewBox,
  coordinate,
  isSelecting,
  refAreaLeft,
  refAreaRight,
  invalidSelection,
}: TooltipProps) => {
  if (!active) return null;

  // Show zoom range when selecting
  if (isSelecting && refAreaLeft && refAreaRight) {
    // Show warning message if selection is too small
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
};

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

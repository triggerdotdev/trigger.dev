import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
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
  ChartTooltipContent,
} from "~/components/primitives/charts/Chart";
import { cn } from "~/utils/cn";
import { AnimatedNumber } from "../AnimatedNumber";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";
import { Spinner } from "../Spinner";
import { ChartLoading } from "./ChartLoading";

//TODO: render a vertical line that follows the mouse - show this on all charts. Use a reference line
//TODO: do a better job of showing extra data in the legend - like in a table
//TODO: fix the first and last bars in a stack not having rounded corners
//TODO: change the cursor to a crosshair when hovering over the chart
//TODO: make a nice loading state for the chart

type ReferenceLineProps = {
  value: number;
  label: string;
};

export function ChartBar({
  config,
  data: initialData,
  dataKey,
  loading = false,
  maxLegendItems = 5,
  referenceLine,
}: {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  loading?: boolean;
  maxLegendItems?: number;
  referenceLine?: ReferenceLineProps;
}) {
  const [activePayload, setActivePayload] = React.useState<any[] | null>(null);
  const [activeBarKey, setActiveBarKey] = React.useState<string | null>(null);
  const [activeDataPointIndex, setActiveDataPointIndex] = React.useState<number | null>(null);

  // Zoom state
  const [refAreaLeft, setRefAreaLeft] = React.useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = React.useState<string | null>(null);
  const [startIndex, setStartIndex] = React.useState<number>(0);
  const [endIndex, setEndIndex] = React.useState<number>(initialData.length - 1);
  const [originalData, setOriginalData] = React.useState<any[]>(initialData);
  const [isSelecting, setIsSelecting] = React.useState(false);
  const [zoomMessage, setZoomMessage] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const zoomMessageTimeoutRef = React.useRef<number | null>(null);

  // Compute the visible data based on the current zoom indices
  const data = React.useMemo(() => {
    return originalData.slice(startIndex, endIndex + 1);
  }, [originalData, startIndex, endIndex]);

  // Initialize data
  React.useEffect(() => {
    setOriginalData(initialData);
    setStartIndex(0);
    setEndIndex(initialData.length - 1);
  }, [initialData]);

  // Clear zoom message timeout on unmount
  React.useEffect(() => {
    return () => {
      if (zoomMessageTimeoutRef.current !== null) {
        window.clearTimeout(zoomMessageTimeoutRef.current);
      }
    };
  }, []);

  const dimmedOpacity = 0.2;

  // Calculate totals for each category
  const totals = React.useMemo(() => {
    return data.reduce((acc, item) => {
      Object.entries(item).forEach(([key, value]) => {
        if (key !== dataKey) {
          acc[key] = (acc[key] || 0) + (value as number);
        }
      });
      return acc;
    }, {} as Record<string, number>);
  }, [data, dataKey]);

  // Get all data keys except the x-axis key
  const dataKeys = Object.keys(config).filter((k) => k !== dataKey);

  // Get current data for the legend based on hover state
  const currentData = React.useMemo(() => {
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
  const resetHighlightState = () => {
    setActiveBarKey(null);
    setActiveDataPointIndex(null);
    setActivePayload(null);
  };

  // Prepare legend payload with capped items
  const legendPayload = React.useMemo(() => {
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

  // Show zoom message with auto-dismiss
  const showZoomMessage = (message: string) => {
    setZoomMessage(message);

    if (zoomMessageTimeoutRef.current !== null) {
      window.clearTimeout(zoomMessageTimeoutRef.current);
    }

    zoomMessageTimeoutRef.current = window.setTimeout(() => {
      setZoomMessage(null);
      zoomMessageTimeoutRef.current = null;
    }, 2000);
  };

  // Handle mouse down for drag zooming
  const handleMouseDown = (e: any) => {
    if (e.activeLabel) {
      setRefAreaLeft(e.activeLabel);
      setIsSelecting(true);
    }
  };

  // Handle mouse move for drag zooming
  const handleMouseMove = (e: any) => {
    if (isSelecting && e.activeLabel) {
      setRefAreaRight(e.activeLabel);
    }
  };

  // Handle mouse up for drag zooming
  const handleMouseUp = () => {
    if (refAreaLeft && refAreaRight) {
      // Get indices of the selected range
      const leftIndex = originalData.findIndex((item) => item[dataKey] === refAreaLeft);
      const rightIndex = originalData.findIndex((item) => item[dataKey] === refAreaRight);

      // Ensure left is less than right
      const [start, end] = [leftIndex, rightIndex].sort((a, b) => a - b);

      // Check if the selection is too small
      if (end - start <= 1) {
        showZoomMessage("Selection too small to zoom");
      } else {
        // Update the start and end indices
        if (start !== -1 && end !== -1) {
          setStartIndex(start);
          setEndIndex(end);
        }
      }
    }

    setRefAreaLeft(null);
    setRefAreaRight(null);
    setIsSelecting(false);
  };

  // Reset zoom
  const handleReset = () => {
    setStartIndex(0);
    setEndIndex(originalData.length - 1);
    setZoomMessage(null);
  };

  return (
    <div className="relative flex w-full flex-col">
      <div className="absolute left-0 right-0 top-0 z-10 mb-2 flex items-center justify-between">
        {zoomMessage ? <div className="text-xs text-amber-500">{zoomMessage}</div> : <div></div>}
        <Button
          variant="secondary/small"
          onClick={handleReset}
          disabled={startIndex === 0 && endIndex === originalData.length - 1}
        >
          Reset Zoom
        </Button>
      </div>

      <div
        ref={containerRef}
        className="mt-8 h-[400px] w-full"
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer config={config} className="h-full w-full">
          {loading ? (
            <ChartLoading />
          ) : (
            <BarChart
              data={data}
              barCategoryGap={1}
              className="pr-2"
              onMouseDown={handleMouseDown}
              onMouseMove={(state: any) => {
                // Handle both selection and active payload update
                if (isSelecting && state?.activeLabel) {
                  setRefAreaRight(state.activeLabel);
                }

                // Update active payload for legend
                if (state?.activePayload?.length) {
                  setActivePayload(state.activePayload);
                }
              }}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => {
                handleMouseUp();
                resetHighlightState();
              }}
            >
              <CartesianGrid vertical={false} stroke="#272A2E" />
              <XAxis
                dataKey={dataKey}
                tickLine={false}
                tickMargin={10}
                axisLine={false}
                ticks={
                  data.length > 10
                    ? [data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]
                    : undefined
                }
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
              />
              <ChartTooltip
                cursor={{ fill: "#212327" }}
                content={
                  <XAxisTooltip
                    isSelecting={isSelecting}
                    refAreaLeft={refAreaLeft}
                    refAreaRight={refAreaRight}
                  />
                }
                allowEscapeViewBox={{ x: false, y: true }}
              />
              {dataKeys.map((key, index, array) => {
                // Create individual bars with custom opacity based on hover state
                return (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="a"
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
                    fillOpacity={1} // We'll use a custom Cell component to handle opacity
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
                    {/* Add cells to customize opacity for each individual bar */}
                    {data.map((_, dataIndex) => {
                      // Calculate opacity for this specific bar
                      // If we have an active bar (either by hovering a bar or a legend item)
                      let opacity = 1;

                      // Case 1: Hovering a specific bar
                      if (activeBarKey !== null && activeDataPointIndex !== null) {
                        // Only show full opacity for the exact bar being hovered
                        opacity =
                          key === activeBarKey && dataIndex === activeDataPointIndex
                            ? 1
                            : dimmedOpacity;
                      }
                      // Case 2: Hovering a legend item
                      else if (activeBarKey !== null && activeDataPointIndex === null) {
                        // Show all bars of this type with full opacity
                        opacity = key === activeBarKey ? 1 : dimmedOpacity;
                      }
                      // Otherwise, no active bar - all bars have full opacity

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
                  label={referenceLine.label}
                  isFront={true}
                  stroke="#3B3E45"
                  strokeDasharray="4 4"
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
          )}
        </ChartContainer>
      </div>
    </div>
  );
}

export function ChartLine({
  config,
  data,
  dataKey,
  loading = false,
}: {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  loading?: boolean;
}) {
  return (
    <ChartContainer config={config} className="min-h-[200px] w-full">
      {loading ? (
        <ChartLoading />
      ) : (
        <LineChart
          accessibilityLayer
          data={data}
          margin={{
            left: 12,
            right: 12,
          }}
        >
          <CartesianGrid vertical={false} stroke="#272A2E" />
          <XAxis dataKey={dataKey} tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis axisLine={false} tickLine={false} tickMargin={8} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <Line
            dataKey="desktop"
            type="step"
            stroke="var(--color-desktop)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            dataKey="mobile"
            type="step"
            stroke="var(--color-mobile)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      )}
    </ChartContainer>
  );
}

interface BigNumberProps {
  animate?: boolean;
  loading?: boolean;
  value?: number;
  valueClassName?: string;
  defaultValue?: number;
  suffix?: string;
  suffixClassName?: string;
}

export function BigNumber({
  value,
  defaultValue,
  valueClassName,
  suffix,
  suffixClassName,
  animate = false,
  loading = false,
}: BigNumberProps) {
  const v = value ?? defaultValue;
  return (
    <div
      className={cn(
        "h-full text-[3.75rem] font-normal tabular-nums leading-none text-text-bright",
        valueClassName
      )}
    >
      {loading ? (
        <div className="grid h-full place-items-center">
          <Spinner className="size-6" />
        </div>
      ) : v !== undefined ? (
        <div className="flex items-baseline gap-1">
          {animate ? <AnimatedNumber value={v} /> : v}
          {suffix && <div className={cn("text-xs", suffixClassName)}>{suffix}</div>}
        </div>
      ) : (
        "–"
      )}
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
}: any) => {
  if (!active) return null;

  // Show zoom range when selecting
  if (isSelecting && refAreaLeft && refAreaRight) {
    return (
      <div
        className="absolute whitespace-nowrap rounded border border-blue-800 bg-[#1B2334] px-2 py-1 text-xxs tabular-nums text-blue-400"
        style={{
          left: coordinate?.x,
          top: viewBox?.height + 14,
          transform: "translateX(-50%)",
        }}
      >
        Zoom: {refAreaLeft} to {refAreaRight}
      </div>
    );
  }

  // Default tooltip behavior (show label)
  if (!payload?.length) return null;

  return (
    <div
      className="absolute whitespace-nowrap rounded border border-grid-bright bg-background-dimmed px-2 py-1 text-xxs tabular-nums text-text-dimmed"
      style={{
        left: coordinate?.x,
        top: viewBox?.height + 14,
        transform: "translateX(-50%)",
      }}
    >
      {label}
    </div>
  );
};

function ViewAllDataRow({ remainingCount }: { remainingCount: number }) {
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

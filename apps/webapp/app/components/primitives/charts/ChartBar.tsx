import React from "react";
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
} from "~/components/primitives/charts/Chart";
import { Button } from "../Buttons";
import { Paragraph } from "../Paragraph";
import { ChartLoading } from "./ChartLoading";

//TODO: have the date range data work across all charts
//TODO: render a vertical line that follows the mouse - show this on all charts. Use a reference line
//TODO: do a better job of showing extra data in the legend - like in a table
//TODO: fix the first and last bars in a stack not having rounded corners
//TODO: make a nice loading state for the chart
//TODO: make a nice "No data: There's no data available for your filters" for the chart with 'clear filters' button
//TODO: make a nice "Chart invalid: The current filters are preventing this chart from being displayed." state for the chart with 'clear filters' button

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
  const [invalidSelection, setInvalidSelection] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

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

  // Handle mouse down for drag zooming
  const handleMouseDown = (e: any) => {
    if (e.activeLabel) {
      setRefAreaLeft(e.activeLabel);
      setIsSelecting(true);
    }
  };

  // Handle mouse move for drag zooming
  const handleMouseMove = (e: any) => {
    // Handle both selection and active payload update
    if (isSelecting && e?.activeLabel) {
      setRefAreaRight(e.activeLabel);

      // Check if selection is likely to be too small
      if (refAreaLeft) {
        const leftIndex = originalData.findIndex((item) => item[dataKey] === refAreaLeft);
        const rightIndex = originalData.findIndex((item) => item[dataKey] === e.activeLabel);
        const [start, end] = [leftIndex, rightIndex].sort((a, b) => a - b);

        // Mark as invalid if the selection is too small
        setInvalidSelection(end - start <= 1);
      }
    }

    // Update active payload for legend
    if (e?.activePayload?.length) {
      setActivePayload(e.activePayload);
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
        // We don't need to show a message here anymore as it's shown in the tooltip
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
    setInvalidSelection(false);
  };

  // Reset zoom
  const handleReset = () => {
    setStartIndex(0);
    setEndIndex(originalData.length - 1);
  };

  return (
    <div className="relative flex w-full flex-col">
      <div className="absolute left-0 right-0 top-0 z-10 mb-2 flex items-center justify-end">
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
        className="mt-8 h-full w-full cursor-crosshair"
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer
          config={config}
          className="h-full w-full [&_.recharts-surface]:cursor-crosshair [&_.recharts-wrapper]:cursor-crosshair"
        >
          {loading ? (
            <ChartLoading />
          ) : (
            <BarChart
              data={data}
              barCategoryGap={1}
              className="pr-2"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
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
                domain={["auto", (dataMax: number) => dataMax * 1.2]}
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
                    fillOpacity={1}
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
}: any) => {
  if (!active) return null;

  // Show zoom range when selecting
  if (isSelecting && refAreaLeft && refAreaRight) {
    // Show warning message if selection is too small
    const message = invalidSelection
      ? "Zoom: Drag a wider range"
      : `Zoom: ${refAreaLeft} to ${refAreaRight}`;

    return (
      <div
        className={`absolute whitespace-nowrap rounded border px-2 py-1 text-xxs tabular-nums ${
          invalidSelection
            ? "border-amber-800 bg-amber-950 text-amber-400"
            : "border-blue-800 bg-[#1B2334] text-blue-400"
        }`}
        style={{
          left: coordinate?.x,
          top: viewBox?.height + 14,
          transform: "translateX(-50%)",
        }}
      >
        {message}
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

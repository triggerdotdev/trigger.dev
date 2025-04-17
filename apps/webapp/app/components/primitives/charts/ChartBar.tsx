import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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

//TODO: set the chart data when zooming to only get the new start and end dates
//TODO: make the text on the chart not selectable when zooming
//TODO: do a better job of showing extra data in the legend - like in a table
//TODO: render a vertical line that follows the mouse - show this on all charts
//TODO: hover over a single bar in the stack and dim all other bars
//TODO: fix the first and last bars not having rounded corners

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
  const [opacity, setOpacity] = React.useState<Record<string, number>>({});
  const [activePayload, setActivePayload] = React.useState<any[] | null>(null);
  const [activeBarKey, setActiveBarKey] = React.useState<string | null>(null);

  // Zoom state
  const [refAreaLeft, setRefAreaLeft] = React.useState<string | null>(null);
  const [refAreaRight, setRefAreaRight] = React.useState<string | null>(null);
  const [data, setData] = React.useState<any[]>(initialData);
  const [originalData, setOriginalData] = React.useState<any[]>(initialData);
  const [isSelecting, setIsSelecting] = React.useState(false);
  const [zoomMessage, setZoomMessage] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const zoomMessageTimeoutRef = React.useRef<number | null>(null);

  // Initialize data
  React.useEffect(() => {
    setData(initialData);
    setOriginalData(initialData);
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
  const animationDuration = 0.3;

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

  // Handle opacity
  React.useEffect(() => {
    const initialOpacity = Object.keys(config).reduce((acc, key) => {
      if (key !== dataKey) {
        acc[key] = 1;
      }
      return acc;
    }, {} as Record<string, number>);
    setOpacity(initialOpacity);
  }, [config, dataKey]);

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

  const style = {
    ...Object.entries(opacity).reduce((acc, [key, value]) => {
      acc[`--opacity-${key}`] = value;
      return acc;
    }, {} as Record<string, string | number>),
  } as React.CSSProperties;

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
        // Update the data with the zoomed range
        if (start !== -1 && end !== -1) {
          setData(originalData.slice(start, end + 1));
        }
      }
    }

    setRefAreaLeft(null);
    setRefAreaRight(null);
    setIsSelecting(false);
  };

  // Reset zoom
  const handleReset = () => {
    setData(originalData);
    setZoomMessage(null);
  };

  // Handle wheel zoom
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();

    if (!containerRef.current) return;

    const zoomFactor = 0.1;
    const direction = e.deltaY < 0 ? 1 : -1; // 1 for zoom in, -1 for zoom out

    // If zooming out and we're already at the original data set, do nothing
    if (direction < 0 && data.length === originalData.length) {
      showZoomMessage("Maximum zoom out reached");
      return;
    }

    // If zooming in and we can't zoom in any further, do nothing
    const MIN_VISIBLE_ITEMS = 3;
    if (direction > 0 && data.length <= MIN_VISIBLE_ITEMS) {
      showZoomMessage("Maximum zoom in reached");
      return;
    }

    // Get chart bounds and mouse position
    const chartRect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - chartRect.left;
    const chartWidth = chartRect.width;
    const mousePercentage = Math.max(0, Math.min(1, mouseX / chartWidth));

    // Calculate how many items to add/remove
    const removeCount = Math.max(1, Math.floor(data.length * zoomFactor * Math.abs(direction)));

    if (direction > 0) {
      // Zoom in - remove items from both sides based on mouse position
      const leftRemove = Math.max(0, Math.floor(removeCount * mousePercentage));
      const rightRemove = Math.max(0, removeCount - leftRemove);

      const newStartIndex = Math.min(leftRemove, data.length - MIN_VISIBLE_ITEMS);
      const newEndIndex = Math.max(MIN_VISIBLE_ITEMS - 1, data.length - rightRemove - 1);

      if (newEndIndex - newStartIndex >= MIN_VISIBLE_ITEMS - 1) {
        setData(data.slice(newStartIndex, newEndIndex + 1));
      } else {
        showZoomMessage("Maximum zoom in reached");
      }
    } else {
      // Zoom out - add items from original data
      // Find where current data starts in original data
      const currentFirstItem = data[0][dataKey];
      const currentLastItem = data[data.length - 1][dataKey];
      let startIdx = originalData.findIndex((item) => item[dataKey] === currentFirstItem);
      let endIdx = originalData.findIndex((item) => item[dataKey] === currentLastItem);

      if (startIdx === -1 || endIdx === -1) return;

      // Calculate how many items to add on each side based on mouse position
      const leftAdd = Math.floor(removeCount * mousePercentage);
      const rightAdd = removeCount - leftAdd;

      // Expand the range
      startIdx = Math.max(0, startIdx - leftAdd);
      endIdx = Math.min(originalData.length - 1, endIdx + rightAdd);

      setData(originalData.slice(startIdx, endIdx + 1));
    }
  };

  return (
    <div className="relative flex w-full flex-col">
      <div className="absolute left-0 right-0 top-0 z-10 mb-2 flex items-center justify-between">
        {zoomMessage ? <div className="text-xs text-amber-500">{zoomMessage}</div> : <div></div>}
        <Button
          variant="secondary/small"
          onClick={handleReset}
          disabled={data.length === originalData.length}
        >
          Reset Zoom
        </Button>
      </div>

      <div
        ref={containerRef}
        className="mt-8 h-[400px] w-full"
        style={{ touchAction: "none", userSelect: "none" }}
        onWheel={handleWheel}
      >
        <ChartContainer
          config={config}
          className="h-full w-full [--transition-duration:300ms]"
          style={style}
        >
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
                setActiveBarKey(null);
                setActivePayload(null);
                setOpacity((op) =>
                  Object.keys(op).reduce((acc, k) => {
                    acc[k] = 1;
                    return acc;
                  }, {} as Record<string, number>)
                );
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
                content={<XAxisTooltip />}
                allowEscapeViewBox={{ x: false, y: true }}
              />
              {dataKeys.map((key, index, array) => (
                <Bar
                  key={key}
                  dataKey={key}
                  stackId="a"
                  fill={`var(--color-${key})`}
                  radius={
                    [
                      index === array.length - 1 ? 2 : 0,
                      index === array.length - 1 ? 2 : 0,
                      index === 0 ? 2 : 0,
                      index === 0 ? 2 : 0,
                    ] as [number, number, number, number]
                  }
                  activeBar={false}
                  style={{ transition: "fill-opacity var(--transition-duration)" }}
                  fillOpacity={opacity[key]}
                  onMouseEnter={(data) => {
                    if (data.tooltipPayload?.[0]) {
                      const { dataKey: hoveredKey } = data.tooltipPayload[0];
                      setActiveBarKey(hoveredKey);
                      setOpacity((op) =>
                        Object.keys(op).reduce((acc, k) => {
                          acc[k] = k === hoveredKey ? 1 : dimmedOpacity;
                          return acc;
                        }, {} as Record<string, number>)
                      );
                    }
                  }}
                  onMouseLeave={() => {
                    setActiveBarKey(null);
                    setActivePayload(null);
                    setOpacity((op) =>
                      Object.keys(op).reduce((acc, k) => {
                        acc[k] = 1;
                        return acc;
                      }, {} as Record<string, number>)
                    );
                  }}
                  isAnimationActive={false}
                />
              ))}
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
                  strokeOpacity={0.3}
                  fill="#3B82F6"
                  fillOpacity={0.1}
                />
              )}

              <ChartLegend
                content={
                  <ChartLegendContentRows
                    onMouseEnter={(data) => {
                      if (data.dataKey === "view-more") return;
                      setActiveBarKey(data.dataKey);
                      setOpacity((op) =>
                        Object.keys(op).reduce((acc, k) => {
                          acc[k] = k === data.dataKey ? 1 : dimmedOpacity;
                          return acc;
                        }, {} as Record<string, number>)
                      );
                    }}
                    onMouseLeave={() => {
                      setActiveBarKey(null);
                      setActivePayload(null);
                      setOpacity((op) =>
                        Object.keys(op).reduce((acc, k) => {
                          acc[k] = 1;
                          return acc;
                        }, {} as Record<string, number>)
                      );
                    }}
                    data={currentData}
                    animationDuration={animationDuration}
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

const XAxisTooltip = ({ active, payload, label, viewBox, coordinate }: any) => {
  if (!active || !payload?.length) return null;

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

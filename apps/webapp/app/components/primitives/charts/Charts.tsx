import { Bar, BarChart, CartesianGrid, Line, LineChart, Legend, XAxis, YAxis } from "recharts";
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
import { Spinner } from "../Spinner";
import React from "react";

//TODO: draw a separate line to indicate e.g. concurrency level
//TODO: render a vertical line that follows the mouse

export function ChartStacked({
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
  const [opacity, setOpacity] = React.useState<Record<string, number>>({});
  const [activePayload, setActivePayload] = React.useState<any[] | null>(null);
  const [activeBarKey, setActiveBarKey] = React.useState<string | null>(null);

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

  const currentData =
    activePayload?.reduce((acc, item) => {
      acc[item.dataKey] = item.value;
      return acc;
    }, {} as Record<string, number>) ?? totals;

  const style = {
    ...Object.entries(opacity).reduce((acc, [key, value]) => {
      acc[`--opacity-${key}`] = value;
      return acc;
    }, {} as Record<string, string | number>),
  } as React.CSSProperties;

  return (
    <ChartContainer
      config={config}
      className="min-h-full w-full [--transition-duration:300ms]"
      style={style}
    >
      {loading ? (
        <ChartLoading />
      ) : (
        <BarChart
          accessibilityLayer
          data={data}
          barCategoryGap={2}
          onMouseMove={(state: any) => {
            if (state?.activePayload?.length > 0) {
              setActivePayload(state.activePayload);
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
        >
          <CartesianGrid vertical={false} stroke="#272A2E" />
          <XAxis
            dataKey={dataKey}
            tickLine={false}
            tickMargin={10}
            axisLine={false}
            ticks={[data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]}
            tick={{ fill: "#878C99", fontSize: 11, style: { fontVariantNumeric: "tabular-nums" } }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            tick={{ fill: "#878C99", fontSize: 11, style: { fontVariantNumeric: "tabular-nums" } }}
          />
          <ChartTooltip
            cursor={{ fill: "#212327" }}
            content={<XAxisTooltip />}
            position={{ y: undefined }}
            coordinate={{ y: undefined }}
            offset={16}
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
                  index === array.length - 1 ? 4 : 0,
                  index === array.length - 1 ? 4 : 0,
                  index === 0 ? 4 : 0,
                  index === 0 ? 4 : 0,
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
            />
          ))}
          <ChartLegend
            content={
              <ChartLegendContentRows
                onMouseEnter={(data) => {
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
              />
            }
          />
        </BarChart>
      )}
    </ChartContainer>
  );
}

export function ChartBar({
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
    <ChartContainer config={config} className="min-h-full w-full">
      {loading ? (
        <ChartLoading />
      ) : (
        <BarChart accessibilityLayer data={data} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="#272A2E" />
          <XAxis dataKey={dataKey} tickLine={false} tickMargin={8} axisLine={false} />
          <YAxis axisLine={false} tickLine={false} tickMargin={8} />
          <ChartTooltip
            cursor={false}
            animationDuration={200}
            content={<ChartTooltipContent hideLabel />}
          />
          <Bar dataKey="value" fill="#6366F1" radius={4} />
        </BarChart>
      )}
    </ChartContainer>
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
            type="linear"
            stroke="var(--color-desktop)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            dataKey="mobile"
            type="linear"
            stroke="var(--color-mobile)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      )}
    </ChartContainer>
  );
}

export function ChartStepped({
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

function ChartLoading() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner className="size-6" />
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

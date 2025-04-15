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
  const [opacity, setOpacity] = React.useState({
    completed: 1,
    "in-progress": 1,
    canceled: 1,
    failed: 1,
  });

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

  const handleMouseEnter = (e: any) => {
    const key = e.dataKey;
    setOpacity((op) => ({
      ...op,
      completed: key === "completed" ? 1 : dimmedOpacity,
      "in-progress": key === "in-progress" ? 1 : dimmedOpacity,
      canceled: key === "canceled" ? 1 : dimmedOpacity,
      failed: key === "failed" ? 1 : dimmedOpacity,
    }));
  };

  const handleMouseLeave = () => {
    setOpacity({
      completed: 1,
      "in-progress": 1,
      canceled: 1,
      failed: 1,
    });
  };

  const style = {
    "--opacity-completed": opacity.completed,
    "--opacity-in-progress": opacity["in-progress"],
    "--opacity-canceled": opacity.canceled,
    "--opacity-failed": opacity.failed,
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
        <BarChart accessibilityLayer data={data} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="#272A2E" />
          <XAxis
            dataKey={dataKey}
            tickLine={false}
            tickMargin={10}
            axisLine={false}
            ticks={[data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]}
            tick={{ fill: "#878C99" }}
          />
          <YAxis axisLine={false} tickLine={false} tickMargin={8} tick={{ fill: "#878C99" }} />
          <ChartTooltip
            cursor={{ fill: "#212327" }}
            content={<XAxisTooltip />}
            position={{ y: undefined }}
            coordinate={{ y: undefined }}
            offset={16}
            allowEscapeViewBox={{ x: false, y: true }}
          />
          <Bar
            dataKey="completed"
            stackId="a"
            fill="var(--color-completed)"
            radius={[0, 0, 4, 4]}
            activeBar={false}
            style={{ transition: "fill-opacity var(--transition-duration)" }}
            fillOpacity={opacity.completed}
          />
          <Bar
            dataKey="in-progress"
            stackId="a"
            fill="var(--color-in-progress)"
            radius={[0, 0, 0, 0]}
            activeBar={false}
            style={{ transition: "fill-opacity var(--transition-duration)" }}
            fillOpacity={opacity["in-progress"]}
          />
          <Bar
            dataKey="canceled"
            stackId="a"
            fill="var(--color-canceled)"
            radius={[0, 0, 0, 0]}
            activeBar={false}
            style={{ transition: "fill-opacity var(--transition-duration)" }}
            fillOpacity={opacity.canceled}
          />
          <Bar
            dataKey="failed"
            stackId="a"
            fill="var(--color-failed)"
            radius={[4, 4, 0, 0]}
            activeBar={false}
            style={{ transition: "fill-opacity var(--transition-duration)" }}
            fillOpacity={opacity.failed}
          />
          <ChartLegend
            content={
              <ChartLegendContentRows
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                data={totals}
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

//TODO: draw a separate line to indicate concurrency level

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
      className="absolute whitespace-nowrap rounded border border-grid-bright bg-background-dimmed px-2 py-1 text-xs tabular-nums text-text-dimmed"
      style={{
        left: coordinate?.x,
        top: viewBox?.height + 12,
        transform: "translateX(-50%)",
      }}
    >
      {label}
    </div>
  );
};

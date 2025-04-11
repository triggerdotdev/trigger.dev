import { Bar, BarChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/primitives/charts/Chart";

export function ChartBar({
  config,
  data,
  dataKey,
}: {
  config: ChartConfig;
  data: any[];
  dataKey: string;
}) {
  return (
    <ChartContainer config={config} className="min-h-full w-full">
      <BarChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} stroke="#3B3E45" />
        <XAxis dataKey={dataKey} tickLine={false} tickMargin={8} axisLine={false} />
        <YAxis axisLine={false} tickLine={false} tickMargin={8} />
        <ChartTooltip
          cursor={false}
          animationDuration={50}
          content={<ChartTooltipContent hideLabel />}
        />
        <Bar dataKey="value" fill="#6366F1" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}

export function LineChart({ config, data }: { config: ChartConfig; data: any[] }) {
  return (
    <ChartContainer config={config} className="min-h-[200px] w-full">
      <BarChart accessibilityLayer data={data}>
        <CartesianGrid horizontal={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          tickMargin={10}
          axisLine={false}
          tickFormatter={(value) => value.slice(0, 3)}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
        <Line dataKey="value" stroke="#2563eb" />
      </BarChart>
    </ChartContainer>
  );
}

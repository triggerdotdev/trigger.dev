import {
  Label,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Paragraph } from "../primitives/Paragraph";

const tooltipStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  borderRadius: "0.25rem",
  border: "1px solid #1A2434",
  backgroundColor: "#0B1018",
  padding: "0.3rem 0.5rem",
  fontSize: "0.75rem",
  color: "#E2E8F0",
};

export function ConcurrentRunsChart({
  concurrentRunsLimit,
  data,
  hasConcurrencyData,
}: {
  concurrentRunsLimit?: number;
  data: { name: string; maxConcurrentRuns: number }[];
  hasConcurrencyData: boolean;
}) {
  return (
    <div className="relative">
      {!hasConcurrencyData && (
        <Paragraph className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          No concurrent Runs to show
        </Paragraph>
      )}
      <ResponsiveContainer width="100%" height="100%" className="relative min-h-[20rem]">
        <LineChart
          data={data}
          margin={{
            top: 20,
            right: 0,
            left: 0,
            bottom: 10,
          }}
          className="-ml-8"
        >
          <XAxis
            stroke="#94A3B8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            dataKey="name"
            className="text-xs"
          >
            <Label value="Last 30 days" offset={-8} position="insideBottom" fill="#94A3B8" />
          </XAxis>
          <YAxis stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.05)" }} contentStyle={tooltipStyle} />
          {concurrentRunsLimit && (
            <ReferenceLine
              y={concurrentRunsLimit}
              stroke="#F43F5E"
              strokeWidth={1}
              strokeDasharray={5}
              ifOverflow="extendDomain"
              className="text-xs"
            >
              <Label
                value="Concurrent Runs limit"
                offset={8}
                position="insideTopLeft"
                fill="#F43F5E"
              />
            </ReferenceLine>
          )}
          <Line
            dataKey="maxConcurrentRuns"
            name="Concurrent runs"
            stroke="#16A34A"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

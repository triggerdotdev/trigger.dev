import { Label, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Paragraph } from "../../primitives/Paragraph";

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

type DataItem = { date: string; runs: number };

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function DailyRunsChart({
  data,
  hasDailyRunsData,
}: {
  data: DataItem[];
  hasDailyRunsData: boolean;
}) {
  return (
    <div className="relative">
      {!hasDailyRunsData && (
        <Paragraph className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          No daily Runs to show
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
            dataKey={(item: DataItem) => {
              if (!item.date) return "";
              const date = new Date(item.date);
              if (date.getDate() === 1) {
                return dateFormatter.format(date);
              }
              return `${date.getDate()}`;
            }}
            className="text-xs"
          >
            <Label value="Last 30 days" offset={-8} position="insideBottom" fill="#94A3B8" />
          </XAxis>
          <YAxis
            stroke="#94A3B8"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.05)" }}
            contentStyle={tooltipStyle}
            labelFormatter={(value, data) => {
              const dateString = data.at(0)?.payload.date;
              if (!dateString) {
                return "";
              }

              return dateFormatter.format(new Date(dateString));
            }}
          />
          <Line dataKey="runs" name="Runs" stroke="#16A34A" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

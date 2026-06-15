import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  type TooltipProps,
} from "recharts";
import { cn } from "~/utils/cn";
import { formatDateTime } from "./DateTime";
import { Header3 } from "./Headers";
import TooltipPortal from "./TooltipPortal";

type UsageDatum = { date: Date; count: number };

type UnitLabel = { singular: string; plural: string };

export type UsageSparklineProps = {
  /** Equal-width time buckets, oldest first. */
  data?: number[];
  /** Epoch ms of the first bucket's start. When omitted, the last bucket is anchored to now. */
  bucketStartMs?: number;
  /** Width of each bucket in ms. Defaults to one hour. */
  bucketIntervalMs?: number;
  /** Bar colour. Defaults to blue. */
  color?: string;
  /** Unit shown in the tooltip (e.g. calls, tokens). */
  unitLabel?: UnitLabel;
  /** Format the trailing total. Defaults to `toLocaleString`. */
  formatTotal?: (total: number) => string;
  /** Class for the trailing total label. */
  totalClassName?: string;
};

/**
 * Inline 24h sparkline for list rows. Renders a small bar chart plus a trailing
 * total, or an em-dash when there's no data. Shared by the prompts and models
 * lists — keep it presentational (the caller supplies the zero-filled buckets).
 */
export function UsageSparkline({
  data,
  bucketStartMs,
  bucketIntervalMs,
  color = "#3B82F6",
  unitLabel = { singular: "call", plural: "calls" },
  formatTotal,
  totalClassName = "text-blue-400",
}: UsageSparklineProps) {
  if (!data || data.every((v) => v === 0)) {
    return <span className="text-text-dimmed">–</span>;
  }

  const total = data.reduce((a, b) => a + b, 0);
  const max = Math.max(...data);

  // Map each bucket to a dated point so the tooltip can show the window it
  // represents. Buckets are `intervalMs` wide; if the caller didn't pass the
  // first bucket's start, anchor the last bucket to now (hourly default).
  const intervalMs = bucketIntervalMs ?? 3600_000;
  const startMs = bucketStartMs ?? Date.now() - (data.length - 1) * intervalMs;
  const chartData: UsageDatum[] = data.map((count, i) => ({
    date: new Date(startMs + i * intervalMs),
    count,
  }));

  return (
    <div className="flex items-start gap-2">
      <div className="h-6 w-[7rem] rounded-sm">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <YAxis domain={[0, max || 1]} hide />
            <Tooltip
              cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
              content={<UsageSparklineTooltip unitLabel={unitLabel} />}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            <Bar
              dataKey="count"
              fill={color}
              strokeWidth={0}
              isAnimationActive={false}
              minPointSize={1}
            />
            <ReferenceLine y={0} stroke="#2C3034" strokeWidth={1} />
            {max > 0 && (
              <ReferenceLine y={max} stroke="#4D525B" strokeDasharray="4 4" strokeWidth={1} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <span className={cn("-mt-1 text-xs tabular-nums", totalClassName)}>
        {formatTotal ? formatTotal(total) : total.toLocaleString()}
      </span>
    </div>
  );
}

function UsageSparklineTooltip({
  active,
  payload,
  unitLabel,
}: TooltipProps<number, string> & { unitLabel: UnitLabel }) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload as UsageDatum;
  const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
  const formattedDate = formatDateTime(date, "UTC", [], false, true);
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
        <div className="mt-2 text-xs text-text-bright">
          <span className="tabular-nums">{entry.count.toLocaleString()}</span>{" "}
          <span className="text-text-dimmed">
            {entry.count === 1 ? unitLabel.singular : unitLabel.plural}
          </span>
        </div>
      </div>
    </TooltipPortal>
  );
}

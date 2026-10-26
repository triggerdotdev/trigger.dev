import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  type TooltipProps,
} from "recharts";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { formatAlertTick } from "./formatAlertTick";
import type { MetricSeriesPoint } from "~/components/alerts/alertSeriesTypes";

function SparklineTooltip({
  active,
  payload,
  unit,
}: TooltipProps<number, string> & { unit: { singular: string; plural: string } }) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0]!.payload as MetricSeriesPoint;
  if (entry.value === null) return null;
  const date = new Date(entry.bucket);

  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-border-bright pb-2">
          {formatDateTime(date, "UTC", [], false, true)}
        </Header3>
        <div className="mt-2 text-xs text-text-bright">
          <span className="tabular-nums">{Math.round(entry.value)}</span>{" "}
          <span className="text-text-dimmed">
            {entry.value === 1 ? unit.singular : unit.plural}
          </span>
        </div>
      </div>
    </TooltipPortal>
  );
}

function SparklineBlankState() {
  return (
    <div className="flex h-6 w-28 items-end gap-px rounded-sm">
      {[...Array(24)].map((_, index) => (
        <div key={index} className="h-full flex-1 bg-background-hover" />
      ))}
    </div>
  );
}

/** @knipignore */
export function AlertMetricSparkline({
  series,
  unit = { singular: "reading", plural: "readings" },
  valueUnit = "",
}: {
  series?: MetricSeriesPoint[];
  unit?: { singular: string; plural: string };
  valueUnit?: string;
}) {
  if (!series || series.length === 0) return <SparklineBlankState />;

  const data = series.map((p) => ({ bucket: p.bucket, value: p.value }));
  const maxValue = Math.max(0, ...data.map((d) => d.value ?? 0));
  if (maxValue === 0) return <SparklineBlankState />;

  return (
    <div className="flex items-start gap-1.5">
      <div className="h-6 w-28 rounded-sm">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <YAxis domain={[0, maxValue || 1]} hide />
            <Tooltip
              cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
              content={<SparklineTooltip unit={unit} />}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            <Bar
              dataKey="value"
              fill="#6366F1"
              strokeWidth={0}
              isAnimationActive={false}
              minPointSize={1}
            />
            <ReferenceLine y={0} stroke="var(--color-border-bright)" strokeWidth={1} />
            {maxValue > 0 && (
              <ReferenceLine
                y={maxValue}
                stroke="var(--color-border-brighter)"
                strokeDasharray="4 4"
                strokeWidth={1}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SimpleTooltip
        asChild
        disableHoverableContent
        button={
          <span className="-mt-1 text-xxs tabular-nums text-text-dimmed">
            {formatAlertTick(maxValue, valueUnit)}
          </span>
        }
        content="Peak reading in the series"
      />
    </div>
  );
}

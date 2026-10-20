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
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { EVENT_CHART_COLOR } from "./ActivityBars";

type ActivityBucket = { date: Date | string; count: number | null };
type ActivityUnit = { singular: string; plural: string };

export function ActivityTooltip({
  active,
  payload,
  unit,
  format,
}: TooltipProps<number, string> & {
  unit: ActivityUnit;
  format?: (count: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0]!.payload as ActivityBucket;
  if (entry.count === null) return null;
  const date = entry.date instanceof Date ? entry.date : new Date(entry.date);

  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-border-bright pb-2">
          {formatDateTime(date, "UTC", [], false, true)}
        </Header3>
        <div className="mt-2 text-xs text-text-bright">
          {format ? (
            <span className="tabular-nums">{format(entry.count)}</span>
          ) : (
            <>
              <span className="tabular-nums">{entry.count}</span>{" "}
              <span className="text-text-dimmed">
                {entry.count === 1 ? unit.singular : unit.plural}
              </span>
            </>
          )}
        </div>
      </div>
    </TooltipPortal>
  );
}

export function ActivityBlankState() {
  return (
    <div className="flex h-6 w-28 items-end gap-px rounded-sm">
      {[...Array(24)].map((_, index) => (
        <div key={index} className="h-full flex-1 bg-background-hover" />
      ))}
    </div>
  );
}

export type StateBucket = { date: Date | string | number; raised: boolean };

export function StateTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0]!.payload as StateBucket;
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-border-bright pb-2">
          {formatDateTime(new Date(entry.date), "UTC", [], false, true)}
        </Header3>
        <div className="mt-2 text-xs text-text-bright">{entry.raised ? "Raised" : "OK"}</div>
      </div>
    </TooltipPortal>
  );
}

export function StateBarsCell({ buckets }: { buckets: StateBucket[] }) {
  const data = buckets.map((b) => ({ ...b, value: b.raised ? 1 : 0 }));
  return (
    <div className="h-6 w-28 rounded-sm">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <YAxis domain={[0, 1]} hide />
          <Tooltip
            cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
            content={<StateTooltip />}
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ zIndex: 1000 }}
            animationDuration={0}
          />
          <Bar
            dataKey="value"
            fill={EVENT_CHART_COLOR}
            strokeWidth={0}
            isAnimationActive={false}
            minPointSize={1}
          />
          <ReferenceLine y={0} stroke="var(--color-border-bright)" strokeWidth={1} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

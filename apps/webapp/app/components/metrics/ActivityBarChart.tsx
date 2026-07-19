import { type ReactElement, type ReactNode } from "react";
import { BarChart, ReferenceLine, Tooltip, YAxis } from "recharts";
import { SimpleTooltip } from "~/components/primitives/Tooltip";

// Fixed px dims skip ResponsiveContainer's ResizeObserver — otherwise every panel resize
// re-renders all the charts in a list at once.
export const ACTIVITY_CHART_WIDTH = 112;
export const ACTIVITY_CHART_HEIGHT = 24;
export const ACTIVITY_CHART_PEAK_CLASS =
  "-mt-1 inline-block min-w-7 text-xxs tabular-nums text-text-dimmed";

type ActivityBarChartProps = {
  /** Recharts row data; each row is a bucket. The bar `children` read their `dataKey`s off it. */
  data: ReadonlyArray<Record<string, unknown>>;
  /** Y-axis domain top and the height of the dashed peak line. */
  max: number;
  /** The `<Bar>` element(s) — one stacked series per bar, or a single bar with `<Cell>`s. */
  children: ReactNode;
  /** Recharts `<Tooltip content>` element for the per-bucket hover card. */
  tooltip: ReactElement;
  /** Trailing peak label shown to the right of the chart. */
  peak: ReactNode;
  /** Optional tooltip wrapping the peak label. */
  peakTooltip?: ReactNode;
  /** Chart width in px. Defaults to the shared ACTIVITY_CHART_WIDTH. */
  width?: number;
};

/**
 * Shared visual frame for the inline activity/backlog mini bar charts (tasks page + queues list).
 * Owns the fixed dimensions, y-axis, hover tooltip, baseline, dashed peak line, and the trailing
 * peak label — the single source of truth for how these charts look. Callers supply the bars and
 * the tooltip content, which is where the two usages differ (stacked per-status vs. single series).
 */
export function ActivityBarChart({
  data,
  max,
  children,
  tooltip,
  peak,
  peakTooltip,
  width = ACTIVITY_CHART_WIDTH,
}: ActivityBarChartProps) {
  return (
    <div className="flex items-start gap-1.5">
      <div className="rounded-sm" style={{ width, height: ACTIVITY_CHART_HEIGHT }}>
        <BarChart
          data={data as Record<string, unknown>[]}
          width={width}
          height={ACTIVITY_CHART_HEIGHT}
          margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
        >
          <YAxis domain={[0, max || 1]} hide />
          <Tooltip
            cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
            content={tooltip}
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ zIndex: 1000 }}
            animationDuration={0}
          />
          {children}
          <ReferenceLine y={0} stroke="var(--color-border-bright)" strokeWidth={1} />
          {max > 0 && (
            <ReferenceLine
              y={max}
              stroke="var(--color-border-brighter)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          )}
        </BarChart>
      </div>
      <ActivityPeakLabel tooltip={peakTooltip}>{peak}</ActivityPeakLabel>
    </div>
  );
}

function ActivityPeakLabel({ tooltip, children }: { tooltip?: ReactNode; children: ReactNode }) {
  const label = <span className={ACTIVITY_CHART_PEAK_CLASS}>{children}</span>;
  if (!tooltip) return label;
  return <SimpleTooltip asChild button={label} content={tooltip} />;
}

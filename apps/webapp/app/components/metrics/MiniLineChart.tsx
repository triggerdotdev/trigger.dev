import { type ReactNode } from "react";
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  YAxis,
} from "recharts";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import {
  ACTIVITY_CHART_HEIGHT,
  ACTIVITY_CHART_PEAK_CLASS,
  ACTIVITY_CHART_WIDTH,
} from "./ActivityBarChart";

type UnitLabel = { singular: string; plural: string };

/** Extra px above the plot so the hover activeDot at the peak value isn't clipped by the SVG edge. */
const DOT_HEADROOM = 3;

type MiniLineChartDatum = {
  date: Date;
  count: number;
  /** Raw per-bucket throttled count (tooltip). */
  throttledCount: number;
  /** The queued value again, present only around throttled buckets, so the warning overlay
   * retraces the same line and reads as one line changing colour. */
  throttledOverlay: number | null;
};

export type MiniLineChartProps = {
  /** Equal-width time buckets, oldest first. */
  data?: number[];
  /**
   * Per-bucket throttled counts aligned 1:1 with `data`. Where throttling occurred, the queued
   * line itself is retraced in the warning colour — one line that changes colour, with the
   * throttled magnitude carried by the tooltip.
   */
  throttled?: number[];
  /** Tooltip wording for the overlay buckets. Null omits the overlay line. */
  overlayLabel?: string | null;
  /** Epoch ms of the first bucket's start. */
  bucketStartMs?: number;
  /** Width of each bucket in ms. Defaults to one hour. */
  bucketIntervalMs?: number;
  /** Line colour for the queued series. */
  color?: string;
  /** Trailing peak scalar shown after the chart. Defaults to the max of the buckets. */
  peak?: number;
  /** Format the trailing peak label. Defaults to `toLocaleString`. */
  formatPeak?: (peak: number) => string;
  /** Tooltip content shown on hover of the trailing peak label. */
  peakTooltip?: ReactNode;
  /** Unit shown in the per-bucket tooltip (e.g. queued, runs). */
  unitLabel?: UnitLabel;
  /** Chart width in px. Defaults to the shared ACTIVITY_CHART_WIDTH. Ignored when `fillWidth`. */
  width?: number;
  /** Plot height in px. Defaults to the shared ACTIVITY_CHART_HEIGHT. */
  height?: number;
  /** Stretch the plot to the container width (via ResponsiveContainer) instead of a fixed px width. */
  fillWidth?: boolean;
  /** Show the trailing peak label to the right of the chart. Defaults to true. */
  showPeak?: boolean;
};

/**
 * Inline fixed-size mini line sparkline for list rows, plus a trailing peak label. Presentational —
 * the caller supplies zero/carry-forward-filled buckets. Renders an em-dash when there's no data.
 * The queued series is a thin monotone line (no dots) matching the big Backlog chart; stretches
 * where the queue was throttled retrace the same line in the warning colour. Shares its fixed
 * dimensions and trailing peak label with {@link ActivityBarChart}, but plots lines instead of bars.
 */
export function MiniLineChart({
  data,
  throttled,
  overlayLabel = "throttled",
  bucketStartMs,
  bucketIntervalMs,
  color = "var(--color-tasks)",
  peak: peakOverride,
  formatPeak,
  peakTooltip,
  unitLabel = { singular: "value", plural: "values" },
  width = ACTIVITY_CHART_WIDTH,
  height = ACTIVITY_CHART_HEIGHT,
  fillWidth = false,
  showPeak = true,
}: MiniLineChartProps) {
  const hasPeakOverride = peakOverride !== undefined;
  if (
    !data ||
    data.length === 0 ||
    bucketStartMs === undefined ||
    (data.every((v) => v === 0) && !hasPeakOverride)
  ) {
    return <span className="text-text-dimmed">–</span>;
  }

  // The overlay only draws where throttling happened. Mapping other buckets to null leaves gaps so
  // a wholly-zero throttled series never paints over the queued line.
  const hasThrottled = throttled?.some((v) => v > 0) ?? false;

  const max = Math.max(...data);
  const peak = peakOverride ?? max;

  // Map each bucket to a dated point so the tooltip can show the window it represents.
  const intervalMs = bucketIntervalMs ?? 3600_000;
  const startMs = bucketStartMs;
  const chartData: MiniLineChartDatum[] = data.map((count, i) => {
    const t = throttled?.[i] ?? 0;
    // Extend the mask one bucket forward (a segment needs both endpoints non-null), so even a
    // single throttled bucket draws a visible warning stretch.
    const inOverlay = t > 0 || (throttled?.[i - 1] ?? 0) > 0;
    return {
      date: new Date(startMs + i * intervalMs),
      count,
      throttledCount: t,
      throttledOverlay: inOverlay ? count : null,
    };
  });

  const chart = (
    <LineChart
      data={chartData}
      width={width}
      height={height + DOT_HEADROOM}
      margin={{ top: DOT_HEADROOM, right: 0, left: 0, bottom: 0 }}
    >
      <YAxis domain={[0, max || 1]} hide />
      <Tooltip
        cursor={{ stroke: "rgba(255, 255, 255, 0.2)", strokeWidth: 1 }}
        content={<MiniLineChartTooltip unitLabel={unitLabel} overlayLabel={overlayLabel} />}
        allowEscapeViewBox={{ x: true, y: true }}
        wrapperStyle={{ zIndex: 1000 }}
        animationDuration={0}
      />
      <ReferenceLine y={0} stroke="var(--color-border-bright)" strokeWidth={1} />
      <Line
        type="monotone"
        dataKey="count"
        stroke={color}
        strokeWidth={1}
        dot={false}
        activeDot={{ r: 2.5, fill: color, strokeWidth: 0 }}
        isAnimationActive={false}
      />
      {hasThrottled && (
        <Line
          type="monotone"
          dataKey="throttledOverlay"
          stroke="var(--color-warning)"
          strokeWidth={1}
          dot={false}
          activeDot={{ r: 2.5, fill: "var(--color-warning)", strokeWidth: 0 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      )}
    </LineChart>
  );

  return (
    <div className={`flex items-start gap-1.5${fillWidth ? " w-full" : ""}`}>
      {/* +DOT_HEADROOM of extra height, spent as top margin, so the hover activeDot at the peak
          isn't clipped by the SVG edge while the plotted area stays `height` tall. */}
      <div
        className={`rounded-sm${fillWidth ? " w-full" : ""}`}
        style={{ width: fillWidth ? undefined : width, height: height + DOT_HEADROOM }}
      >
        {/* Fixed px dims skip ResponsiveContainer's ResizeObserver (see ActivityBarChart); with
            fillWidth we opt back into it so the plot stretches to the block. */}
        {fillWidth ? (
          <ResponsiveContainer width="100%" height={height + DOT_HEADROOM}>
            {chart}
          </ResponsiveContainer>
        ) : (
          chart
        )}
      </div>
      {showPeak && (
        <MiniLinePeakLabel tooltip={peakTooltip}>
          {formatPeak ? formatPeak(peak) : peak.toLocaleString()}
        </MiniLinePeakLabel>
      )}
    </div>
  );
}

function MiniLinePeakLabel({ tooltip, children }: { tooltip?: ReactNode; children: ReactNode }) {
  const label = <span className={ACTIVITY_CHART_PEAK_CLASS}>{children}</span>;
  if (!tooltip) return label;
  return <SimpleTooltip asChild button={label} content={tooltip} />;
}

function MiniLineChartTooltip({
  active,
  payload,
  unitLabel,
  overlayLabel = "throttled",
}: TooltipProps<number, string> & { unitLabel: UnitLabel; overlayLabel?: string | null }) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload as MiniLineChartDatum;
  const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
  const formattedDate = formatDateTime(date, "UTC", [], false, true);
  const throttled = entry.throttledCount;
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-border-bright pb-2">{formattedDate}</Header3>
        <div className="mt-2 text-xs text-text-bright">
          <span className="tabular-nums">{entry.count.toLocaleString()}</span>{" "}
          <span className="text-text-dimmed">
            {entry.count === 1 ? unitLabel.singular : unitLabel.plural}
          </span>
        </div>
        {throttled > 0 && overlayLabel !== null && (
          <div className="mt-1 text-xs text-warning">
            <span className="tabular-nums">{throttled.toLocaleString()}</span> {overlayLabel}
          </div>
        )}
      </div>
    </TooltipPortal>
  );
}

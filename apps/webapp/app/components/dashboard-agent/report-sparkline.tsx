/**
 * The graphical parts a report card shares: the severity vocabulary, the metric
 * row, and the bar sparkline that sits in it.
 *
 * Both report cards (the real `ReportView` and the demo mockup) render the same
 * metric row, so it lives here once. The pieces take already-resolved *strings*
 * rather than a metric object: the two cards read from different (structurally
 * identical) types and resolve their labels through different message catalogs,
 * and this way neither concern leaks into the layout.
 *
 * PURE, like `ReportView`: no Remix hooks, no state, no effects. The per-bar
 * hover is CSS-only (a named group), and the metric's note uses the app's
 * `InfoIconTooltip` primitive, which is router-agnostic and brings its own
 * tooltip provider.
 *
 * Why not `MiniLineChart` / `UsageSparkline`: both are single-colour recharts
 * charts. A report sparkline has to paint *per bar* — severity colour for the
 * series, a brighter run for the anomaly window — which neither exposes, and a
 * recharts instance per metric row is a lot of chart for 88px inside a chat
 * panel. So these are plain divs.
 */
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { AgentStatusIcon, type AgentTone } from "./agent-badges";

/** Both cards' severity type (`Severity` / `ReportSeverity`) resolves to this. */
export type ReportSeverityKey = "ok" | "warn" | "crit";

// Semantic tokens, not raw palette classes — those are tuned for the dark theme
// only, and these are what the theme layer remaps (see tailwind.css).
export const SEVERITY_TEXT: Record<ReportSeverityKey, string> = {
  ok: "text-success",
  warn: "text-warning",
  crit: "text-error",
};

export const SEVERITY_BADGE: Record<ReportSeverityKey, string> = {
  ok: "border-success/40 text-success",
  warn: "border-warning/40 text-warning",
  crit: "border-error/40 text-error",
};

const SEVERITY_TONE: Record<ReportSeverityKey, AgentTone> = {
  ok: "success",
  warn: "warning",
  crit: "error",
};

const SEVERITY_ICON = {
  ok: CheckCircleIcon,
  warn: ExclamationTriangleIcon,
  crit: ExclamationCircleIcon,
} as const;

/**
 * The state marker on a finding or a summary statement. A coloured icon rather
 * than a coloured dot, so severity survives a glance — same rule the run status
 * cells follow (`runs/v3/TaskRunStatus`).
 */
export function ReportSeverityIcon({
  severity,
  className,
}: {
  severity: ReportSeverityKey;
  className?: string;
}) {
  return (
    <AgentStatusIcon
      tone={SEVERITY_TONE[severity]}
      icon={SEVERITY_ICON[severity]}
      className={cn("size-3.5", className)}
    />
  );
}

// --- sparkline --------------------------------------------------------------

/**
 * Bars are condensed to at most this many so each one is wide enough to read
 * (and to hover) in the sparkline's column. A 60-point, 60-minute series becomes
 * 15 four-minute bars.
 */
const MAX_BARS = 16;

/** Minimum bar height, so an empty bucket still draws the baseline. */
const FLOOR_PERCENT = 6;

/** The fixed sparkline column — this is what puts every sparkline on one line. */
const SPARK_WIDTH_CLASS = "w-[5.5rem]";

const SPARK_HEIGHT_CLASS = "h-6";

/** Series colour when no anomaly window singles out part of it. */
const BAR_PLAIN: Record<ReportSeverityKey, string> = {
  ok: "bg-success/60",
  warn: "bg-warning/60",
  crit: "bg-error/60",
};

/** Series colour outside the anomaly window — receded, so the window pops. */
const BAR_CALM: Record<ReportSeverityKey, string> = {
  ok: "bg-success/30",
  warn: "bg-warning/25",
  crit: "bg-error/25",
};

/** The anomaly window itself. */
const BAR_HOT: Record<ReportSeverityKey, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  crit: "bg-error",
};

/** Written out per severity because Tailwind can't see a composed class name. */
const BAR_HOVER: Record<ReportSeverityKey, string> = {
  ok: "group-hover/bar:bg-success",
  warn: "group-hover/bar:bg-warning",
  crit: "group-hover/bar:bg-error",
};

/** Average `points` down to at most `maxBars` equal-width buckets, oldest first. */
function condense(points: number[], maxBars: number): number[] {
  if (points.length <= maxBars) return points;
  const stride = points.length / maxBars;
  const bars: number[] = [];
  for (let i = 0; i < maxBars; i++) {
    const from = Math.floor(i * stride);
    const to = Math.max(from + 1, Math.floor((i + 1) * stride));
    const slice = points.slice(from, to);
    bars.push(slice.reduce((sum, n) => sum + n, 0) / slice.length);
  }
  return bars;
}

/** "now" / "12m ago" for the bucket ending `minutesAgo` before the window's end. */
function agoLabel(minutesAgo: number): string {
  const rounded = Math.round(minutesAgo);
  if (rounded <= 0) return "now";
  if (rounded < 60) return `${rounded}m ago`;
  const hours = rounded / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h ago`;
}

/**
 * A metric's series as bars: zero-based (a flat non-zero series reads as flat
 * and *high*, which the min-max ASCII sparkline could not show), coloured by the
 * metric's severity, with the trailing anomaly window painted bright. Hovering a
 * bar shows its value and how long ago it was.
 */
export function ReportSparkline({
  points,
  severity,
  /** Minutes the whole series covers — turns a bar index into "12m ago". */
  windowMinutes,
  /**
   * Length of the finding's anomaly window, when it runs to the end of the
   * series. The matching trailing bars are highlighted.
   */
  anomalyMinutes,
  /** The metric's own formatter, so a hovered bar reads in the metric's unit. */
  formatPoint,
  label,
  className,
}: {
  points: number[];
  severity: ReportSeverityKey;
  windowMinutes: number;
  anomalyMinutes?: number;
  formatPoint: (value: number) => string;
  label: string;
  className?: string;
}) {
  const bars = condense(points, MAX_BARS);
  const max = Math.max(...bars, 0);
  const minutesPerBar = bars.length > 0 ? windowMinutes / bars.length : 0;
  const hotBars =
    anomalyMinutes && minutesPerBar > 0
      ? Math.min(bars.length, Math.max(1, Math.round(anomalyMinutes / minutesPerBar)))
      : 0;
  const calm = hotBars > 0 ? BAR_CALM[severity] : BAR_PLAIN[severity];

  return (
    <div
      className={cn("flex items-end gap-px", SPARK_WIDTH_CLASS, SPARK_HEIGHT_CLASS, className)}
      role="img"
      aria-label={`${label} over the last ${windowMinutes} minutes`}
    >
      {bars.map((value, i) => {
        const height = max > 0 ? Math.max(FLOOR_PERCENT, (value / max) * 100) : FLOOR_PERCENT;
        const hot = i >= bars.length - hotBars;
        return (
          <span
            key={i}
            className="group/bar relative flex h-full min-w-0 flex-1 items-end"
            // The hover label is decorative duplication of the aria-label above.
            aria-hidden
          >
            <span
              className={cn(
                "w-full rounded-[1px] transition-colors",
                hot ? BAR_HOT[severity] : calm,
                BAR_HOVER[severity]
              )}
              style={{ height: `${height}%` }}
            />
            <span className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 hidden whitespace-nowrap rounded border border-grid-bright bg-background-bright px-1.5 py-0.5 text-xs tabular-nums text-text-bright shadow-md group-hover/bar:block">
              {formatPoint(value)}
              <span className="text-text-dimmed">
                {" "}
                · {agoLabel((bars.length - 1 - i) * minutesPerBar)}
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

// --- metric row -------------------------------------------------------------

/**
 * Label | value | sparkline, in fixed columns. The sparkline column is the point
 * of the grid: every row's chart starts on the same vertical line, whatever the
 * value's width, and nothing else is allowed into that column.
 */
const METRIC_ROW_CLASS = "grid grid-cols-[5rem_minmax(0,1fr)_5.5rem] items-center gap-x-2";

export function ReportMetricRow({
  label,
  value,
  severity,
  /** A composite metric's parts, e.g. "820 done · 6,300 triggered". */
  breakdown,
  /** The trend chip, e.g. "↑6×". */
  delta,
  /**
   * The row's aside — the metric's annotation, its baseline, or "estimated".
   * It goes in a tooltip rather than inline: as trailing text it broke the
   * sparkline column and read like part of the value.
   */
  note,
  series,
  windowMinutes,
  anomalyMinutes,
  formatPoint,
}: {
  label: string;
  value: string;
  severity: ReportSeverityKey;
  breakdown?: string;
  delta?: string;
  note?: string;
  series?: number[];
  windowMinutes: number;
  anomalyMinutes?: number;
  formatPoint: (value: number) => string;
}) {
  return (
    <li className={cn(METRIC_ROW_CLASS, "text-sm")}>
      <span className="truncate text-text-dimmed">{label}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className={cn("font-medium tabular-nums", SEVERITY_TEXT[severity])}>{value}</span>
          {delta ? <span className="tabular-nums text-text-dimmed">{delta}</span> : null}
          {note ? <InfoIconTooltip content={note} /> : null}
        </span>
        {breakdown ? <span className="text-xs text-text-dimmed">{breakdown}</span> : null}
      </span>
      {series && series.length > 0 ? (
        <ReportSparkline
          points={series}
          severity={severity}
          windowMinutes={windowMinutes}
          anomalyMinutes={anomalyMinutes}
          formatPoint={formatPoint}
          label={label}
        />
      ) : (
        // Keeps the column occupied so a series-less metric doesn't pull the
        // rows out of alignment.
        <span className={SPARK_WIDTH_CLASS} aria-hidden />
      )}
    </li>
  );
}

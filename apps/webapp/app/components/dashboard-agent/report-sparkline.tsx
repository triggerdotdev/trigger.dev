/**
 * The parts a report card is built from: the severity vocabulary, the card
 * chrome (header line, headline, note blocks, footer line), the metric row, and
 * the sparkline that sits in it.
 *
 * Both report cards (the real `ReportView` and the demo mockup) render the same
 * layout, so it lives here once. The pieces take already-resolved *strings*
 * rather than a metric object: the two cards read from different (structurally
 * identical) types and resolve their labels through different message catalogs,
 * and this way neither concern leaks into the layout.
 *
 * PURE, like `ReportView`: no Remix hooks, no loader data, no router context.
 * Notes use the app's `InfoIconTooltip` primitive and the sparkline reuses the
 * queue metrics `MiniLineChart`; both are router-agnostic.
 */
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { Children, Fragment, type ReactNode } from "react";
import { Bar, Cell, type TooltipProps } from "recharts";
import { ActivityBarChart } from "~/components/metrics/ActivityBarChart";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import TooltipPortal from "~/components/primitives/TooltipPortal";
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

/** The same three colours as CSS values, for the sparkline's line. */
const SEVERITY_COLOR: Record<ReportSeverityKey, string> = {
  ok: "var(--color-success)",
  warn: "var(--color-warning)",
  crit: "var(--color-error)",
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

// --- card chrome ------------------------------------------------------------

export function ReportCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      {children}
    </div>
  );
}

/**
 * The quiet top line: the report's name on the left, its scope / period /
 * baseline on the right. Anything urgent belongs in the headline below, not here.
 */
export function ReportHeaderLine({
  name,
  meta,
  children,
}: {
  name: string;
  meta: string;
  /** State badges that sit next to the name (e.g. "stale data"). */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-grid-bright px-3 py-2">
      <span className="text-xs font-medium text-text-bright">{name}</span>
      {children}
      <span className="ml-auto text-xs text-text-dimmed">{meta}</span>
    </div>
  );
}

/** The card body. The wide `space-y` is the point — the card is meant to breathe. */
export function ReportBody({ children, dimmed }: { children: ReactNode; dimmed?: boolean }) {
  return <div className={cn("space-y-4 px-3 py-3.5", dimmed && "opacity-80")}>{children}</div>;
}

/**
 * The verdict, as one sentence: severity icon, the coloured phrase that names
 * the state, then a plain continuation that says why.
 */
export function ReportHeadline({
  severity,
  phrase,
  continuation,
}: {
  severity: ReportSeverityKey;
  phrase: string;
  continuation?: string;
}) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <ReportSeverityIcon severity={severity} className="mt-0.5 shrink-0" />
      <span>
        <span className={cn("font-medium", SEVERITY_TEXT[severity])}>{phrase}</span>
        {continuation ? <span className="text-text-bright"> — {continuation}</span> : null}
      </span>
    </p>
  );
}

/** A finding other than the one in the headline: its state, its type, its reason. */
export function ReportFindingLine({
  severity,
  type,
  text,
  bright,
}: {
  severity: ReportSeverityKey;
  type: string;
  text: string;
  bright?: boolean;
}) {
  return (
    <p className="flex items-start gap-2">
      <ReportSeverityIcon severity={severity} className="mt-0.5 shrink-0" />
      <span className="mt-px text-xs uppercase tracking-wide text-text-dimmed">{type}</span>
      <span className={cn("text-sm", bright ? "text-text-bright" : "text-text-dimmed")}>
        {text}
      </span>
    </p>
  );
}

// --- prose highlighting -----------------------------------------------------

/**
 * The highlight rules for report prose ("why:" lines, "read:" lines). Fixed and
 * deterministic — the same kind of thing is always emphasized the same way:
 *
 * 1. **Quantities** — numbers with their unit (`71%`, `~820/min`, `38 min`,
 *    `6×`) render bright and tabular. Numbers are what the user scans for.
 * 2. **Entities** — queue/task/run names the caller passes in render mono and
 *    bright, like code.
 * 3. **Verdict phrases** — the "whose problem is this" answers ("not your
 *    code", "not a code problem", "not the workers") render in the success
 *    color: they are the good news the card exists to deliver.
 * 4. Everything else stays dimmed; causal arrows (→) are structure, not
 *    content, and stay dimmed too.
 */
const QUANTITY_RE = /~?\d[\d,.]*\s?(?:%|×|\/min|ms\b|s\b|min\b|h\b)?/g;

const VERDICT_PHRASES = [
  "not your code",
  "not a code problem",
  "not the workers",
  "not the platform",
];

type ProseSegment = { text: string; kind: "plain" | "quantity" | "entity" | "verdict" };

function splitBy(
  segments: ProseSegment[],
  match: (text: string) => { start: number; end: number } | null,
  kind: ProseSegment["kind"]
): ProseSegment[] {
  return segments.flatMap((segment) => {
    if (segment.kind !== "plain") return [segment];
    const out: ProseSegment[] = [];
    let rest = segment.text;
    for (;;) {
      const hit = match(rest);
      if (!hit) break;
      if (hit.start > 0) out.push({ text: rest.slice(0, hit.start), kind: "plain" });
      out.push({ text: rest.slice(hit.start, hit.end), kind });
      rest = rest.slice(hit.end);
    }
    if (rest) out.push({ text: rest, kind: "plain" });
    return out;
  });
}

/** Apply the highlight rules to one resolved prose line. */
export function ReportProse({ text, entities }: { text: string; entities?: string[] }) {
  let segments: ProseSegment[] = [{ text, kind: "plain" }];

  for (const entity of entities ?? []) {
    if (!entity) continue;
    segments = splitBy(
      segments,
      (t) => {
        const i = t.indexOf(entity);
        return i === -1 ? null : { start: i, end: i + entity.length };
      },
      "entity"
    );
  }

  for (const phrase of VERDICT_PHRASES) {
    segments = splitBy(
      segments,
      (t) => {
        const i = t.toLowerCase().indexOf(phrase);
        return i === -1 ? null : { start: i, end: i + phrase.length };
      },
      "verdict"
    );
  }

  segments = splitBy(
    segments,
    (t) => {
      QUANTITY_RE.lastIndex = 0;
      const m = QUANTITY_RE.exec(t);
      return m && m[0].trim().length > 0 ? { start: m.index, end: m.index + m[0].length } : null;
    },
    "quantity"
  );

  return (
    <>
      {segments.map((segment, i) => {
        switch (segment.kind) {
          case "quantity":
            return (
              <span key={i} className="font-medium tabular-nums text-text-bright">
                {segment.text}
              </span>
            );
          case "entity":
            return (
              <span key={i} className="font-mono text-xs text-text-bright">
                {segment.text}
              </span>
            );
          case "verdict":
            return (
              <span key={i} className="font-medium text-success">
                {segment.text}
              </span>
            );
          default:
            return <Fragment key={i}>{segment.text}</Fragment>;
        }
      })}
    </>
  );
}

/**
 * A labelled block of lines — "why:" (what owns the problem, what it isn't) and
 * "read:" (the plain-language interpretation). The label sits in its own column
 * so the lines hang together as one indented paragraph.
 */
export function ReportNoteBlock({ label, children }: { label: string; children: ReactNode }) {
  const lines = Children.toArray(children).filter(Boolean);
  if (lines.length === 0) return null;

  return (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-1 text-sm">
      <span className="text-text-dimmed">{label}</span>
      <div className="space-y-0.5 text-text-dimmed">
        {lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );
}

/**
 * The footer: an arrow, then every action on one dot-separated line. Buttons for
 * things that happen in the app, links for things that live in the docs.
 */
export function ReportFooterLine({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-grid-bright pt-3 text-sm">
      <span aria-hidden className="text-text-dimmed">
        →
      </span>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden className="text-text-faint">
              ·
            </span>
          ) : null}
          {item}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * A footer entry that reads rather than acts — a doc page, a resolved resource.
 * Underlined text, never a button: a button promises something happens here.
 */
export function ReportFooterLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="text-indigo-500 underline underline-offset-2 transition hover:text-indigo-400"
    >
      {children}
    </a>
  );
}

/** A footer entry that states an option instead of offering one. */
export function ReportFooterNote({ children }: { children: ReactNode }) {
  return <span className="text-text-dimmed">{children}</span>;
}

/** Where the snapshot came from, in the report's own URI vocabulary. */
export function ReportProvenance({ uri }: { uri: string }) {
  return <div className="break-all font-mono text-[10px] text-text-faint">{uri}</div>;
}

// --- sparkline --------------------------------------------------------------

/** The fixed sparkline column — this is what puts every sparkline on one line. */
const SPARK_WIDTH_CLASS = "w-[6.5rem]";

/** The chart's own width; the trailing peak label uses the column's remainder. */
const SPARK_WIDTH = 72;

/** The number of bars a 60-point series is condensed to — chunky, hoverable. */
const MAX_BARS = 18;

/** Average adjacent points down so each bar is wide enough to read and hover. */
function condense(points: number[], maxBars: number): number[] {
  if (points.length <= maxBars) return points;
  const perBar = points.length / maxBars;
  return Array.from({ length: maxBars }, (_, i) => {
    const slice = points.slice(Math.floor(i * perBar), Math.max(Math.floor((i + 1) * perBar), 1));
    return slice.reduce((sum, v) => sum + v, 0) / Math.max(slice.length, 1);
  });
}

type ReportSparkDatum = { count: number; date: Date; hot: boolean };

function ReportSparkTooltip({
  active,
  payload,
  formatPoint,
}: TooltipProps<number, string> & { formatPoint: (value: number) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload as ReportSparkDatum;
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-border-bright pb-2">
          {formatDateTime(entry.date, "UTC", [], false, true)}
        </Header3>
        <div className="mt-2 text-xs tabular-nums text-text-bright">{formatPoint(entry.count)}</div>
        {entry.hot ? <div className="mt-1 text-xs text-warning">in the anomaly window</div> : null}
      </div>
    </TooltipPortal>
  );
}

/**
 * A metric's series as the tasks-page mini bar chart (`ActivityBarChart`):
 * chunky severity-coloured bars with the shared baseline, dashed peak line and
 * trailing peak label. Bars inside the finding's anomaly window paint at full
 * strength; the rest recede to a muted tint of the same colour, so the breach
 * reads as one chart changing intensity, not a second series.
 */
export function ReportSparkline({
  points,
  severity,
  /** Minutes the whole series covers — turns a bar into its tooltip time. */
  windowMinutes,
  /**
   * Length of the finding's anomaly window, when it runs to the end of the
   * series. The matching trailing bars paint at full strength.
   */
  anomalyMinutes,
  /** The metric's own formatter, used by the tooltip and the peak label. */
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
  const windowMs = windowMinutes * 60_000;
  // The view model carries buckets, not timestamps — synthesise them: the
  // series ends now.
  const barIntervalMs = bars.length > 0 ? windowMs / bars.length : windowMs;
  const startMs = Date.now() - windowMs;

  const minutesPerBar = bars.length > 0 ? windowMinutes / bars.length : 0;
  const hotBars =
    anomalyMinutes && minutesPerBar > 0
      ? Math.min(bars.length, Math.max(1, Math.round(anomalyMinutes / minutesPerBar)))
      : 0;

  const data: ReportSparkDatum[] = bars.map((count, i) => ({
    count,
    date: new Date(startMs + i * barIntervalMs),
    hot: i >= bars.length - hotBars,
  }));

  const color = SEVERITY_COLOR[severity];
  const calm = `color-mix(in srgb, ${color} 35%, transparent)`;
  const peak = points.length > 0 ? Math.max(...points) : 0;

  return (
    <div
      className={cn(SPARK_WIDTH_CLASS, className)}
      role="img"
      aria-label={`${label} over the last ${windowMinutes} minutes, peak ${formatPoint(peak)}`}
    >
      <ActivityBarChart
        data={data}
        max={Math.max(...bars, 1)}
        width={SPARK_WIDTH}
        peak={formatPoint(peak)}
        tooltip={<ReportSparkTooltip formatPoint={formatPoint} />}
      >
        <Bar dataKey="count" isAnimationActive={false} minPointSize={1}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.hot || hotBars === 0 ? color : calm} />
          ))}
        </Bar>
      </ActivityBarChart>
    </div>
  );
}

// --- metric row -------------------------------------------------------------

/**
 * LABEL | value | delta | sparkline, in fixed columns. The outer columns are the
 * point of the grid: every row's label starts and every row's chart starts on
 * the same vertical line, whatever the value's width.
 */
const METRIC_ROW_CLASS = "grid grid-cols-[7rem_minmax(0,1fr)_2.75rem_6.5rem] items-center gap-x-2";

// Labels are never truncated — the column is sized for the longest label and
// anything longer wraps to a second line.
const LABEL_CLASS = "text-xs uppercase leading-tight tracking-wide text-text-dimmed";

/** A metric's movement against its baseline. Direction is an arrow, always. */
export type ReportDelta = { text: string; dir: "up" | "down" | "flat" };

/**
 * A view model `Delta` as the row's arrow. A multiplier only reads as movement
 * once it rounds past 1×; below that, a metric with a baseline is simply flat,
 * and a metric without one has nothing to compare against.
 */
export function reportDelta(
  delta: { dir: "up" | "down" | "flat"; mult?: number } | undefined,
  hasBaseline: boolean
): ReportDelta | undefined {
  if (delta && delta.mult !== undefined && delta.mult > 1 && delta.dir !== "flat") {
    return { text: `${delta.dir === "up" ? "↑" : "↓"} ${delta.mult}×`, dir: delta.dir };
  }
  return hasBaseline ? { text: "→ flat", dir: "flat" } : undefined;
}

export function ReportMetricRow({
  label,
  value,
  severity,
  /** A composite metric's parts, indented under it as their own rows. */
  subRows,
  /** The movement against the baseline, e.g. "↑ 6×" or "→ flat". */
  delta,
  /**
   * The row's aside — its baseline, or "estimated". It goes in a tooltip rather
   * than inline: as trailing text it broke the sparkline column and read like
   * part of the value.
   */
  note,
  /**
   * The finding-explaining row's annotation. Joins `note` in the info tooltip —
   * the fact itself already leads the card's headline, so the row doesn't
   * repeat it in the flow.
   */
  heroNote,
  series,
  windowMinutes,
  anomalyMinutes,
  formatPoint,
}: {
  label: string;
  value: string;
  severity: ReportSeverityKey;
  subRows?: { label: string; value: string }[];
  delta?: ReportDelta;
  note?: string;
  heroNote?: string;
  series?: number[];
  windowMinutes: number;
  anomalyMinutes?: number;
  formatPoint: (value: number) => string;
}) {
  const deltaClass =
    delta?.dir === "up"
      ? severity === "ok"
        ? "text-text-dimmed"
        : SEVERITY_TEXT[severity]
      : delta?.dir === "down"
        ? "text-text-dimmed"
        : "text-text-faint";

  return (
    <>
      <li className={METRIC_ROW_CLASS}>
        <span className={LABEL_CLASS}>{label}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("text-sm font-medium tabular-nums", SEVERITY_TEXT[severity])}>
            {value}
          </span>
          {note || heroNote ? (
            <InfoIconTooltip content={[heroNote, note].filter(Boolean).join(" · ")} />
          ) : null}
        </span>
        <span className={cn("whitespace-nowrap text-xs tabular-nums", deltaClass)}>
          {delta?.text ?? ""}
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
          <span aria-hidden />
        )}
      </li>

      {(subRows ?? []).map((sub) => (
        // Sub-values sit in the same column at the same size as the parent's
        // value — only the dimmed color and the indented label say "part of".
        <li key={sub.label} className={METRIC_ROW_CLASS}>
          <span className={cn(LABEL_CLASS, "pl-2.5")}>{sub.label}</span>
          <span className="text-sm tabular-nums text-text-dimmed">{sub.value}</span>
        </li>
      ))}
    </>
  );
}

/** The metric grid. Rows are `ReportMetricRow`s, which may expand to several. */
export function ReportMetricList({ children }: { children: ReactNode }) {
  return <ul className="space-y-2.5">{children}</ul>;
}

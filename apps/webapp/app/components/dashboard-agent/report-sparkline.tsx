/**
 * The parts a report card is built from: severity vocabulary, card chrome, the
 * metric row and its sparkline. Both report cards render this layout, so the
 * pieces take resolved strings rather than metric objects.
 *
 * Keep this file pure: no Remix hooks, no loader data, no router context. Footer
 * `LinkButton`s are only ever given external URLs, which render as plain anchors.
 */
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
} from "@heroicons/react/20/solid";
import { Children, Fragment, type ReactNode } from "react";
import { Bar, Cell, type TooltipProps } from "recharts";
import {
  REPORT_LABELS,
  reportFooterStyle,
  type ReportTone,
} from "~/presenters/v3/reports/report-layout";
import { ActivityBarChart } from "~/components/metrics/ActivityBarChart";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { cn } from "~/utils/cn";
import { AgentStatusIcon, type AgentTone } from "./agent-badges";
import { AgentCard, AgentCardBody, AgentCardHeader } from "./agent-card";
import { barTimesMs, condense, hotBarCount } from "./report-spark";

/** Both cards' severity type (`Severity` / `ReportSeverity`) resolves to this. */
export type ReportSeverityKey = "ok" | "warn" | "crit";

// Semantic tokens, not raw palette classes: only these are remapped by the theme
// layer (see tailwind.css). Keyed by tone, so a genuinely-unknown state can't
// borrow a verdict's colour.
const SEVERITY_TEXT: Record<ReportTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  crit: "text-error",
  neutral: "text-text-dimmed",
};

/** The same colours as CSS values, for the sparkline's line. */
const SEVERITY_COLOR: Record<ReportTone, string> = {
  ok: "var(--color-success)",
  warn: "var(--color-warning)",
  crit: "var(--color-error)",
  neutral: "var(--color-text-dimmed)",
};

const SEVERITY_TONE: Record<ReportTone, AgentTone> = {
  ok: "success",
  warn: "warning",
  crit: "error",
  neutral: "neutral",
};

const SEVERITY_ICON = {
  ok: CheckCircleIcon,
  warn: ExclamationTriangleIcon,
  crit: ExclamationCircleIcon,
  neutral: QuestionMarkCircleIcon,
} as const;

/**
 * The state marker on a finding or a summary statement. `tone` is the shared
 * layout's tone, which is the severity unless the state is genuinely unknown —
 * the card's counterpart to the text surfaces' `○` glyph.
 */
export function ReportSeverityIcon({
  severity,
  tone,
  className,
}: {
  severity: ReportSeverityKey;
  tone?: ReportTone;
  className?: string;
}) {
  const key = tone ?? severity;
  return (
    <AgentStatusIcon
      tone={SEVERITY_TONE[key]}
      icon={SEVERITY_ICON[key]}
      className={cn("size-3.5", className)}
    />
  );
}

// --- card chrome ------------------------------------------------------------

export function ReportCard({ children }: { children: ReactNode }) {
  return <AgentCard>{children}</AgentCard>;
}

/**
 * The quiet top line: the report's name, then its scope, period and baseline.
 * Anything urgent belongs in the headline below.
 */
export function ReportHeaderLine({
  name,
  meta,
  children,
}: {
  name: string;
  meta: string;
  /** State badges that sit next to the name. */
  children?: ReactNode;
}) {
  return (
    <AgentCardHeader className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-text-bright">{name}</span>
      {children}
      <span className="ml-auto text-xs text-text-dimmed">{meta}</span>
    </AgentCardHeader>
  );
}

/** The card body. */
export function ReportBody({ children, dimmed }: { children: ReactNode; dimmed?: boolean }) {
  return <AgentCardBody className={cn(dimmed && "opacity-80")}>{children}</AgentCardBody>;
}

/** The verdict as one sentence: icon, the coloured phrase, then why. */
export function ReportHeadline({
  severity,
  tone,
  phrase,
  continuation,
}: {
  severity: ReportSeverityKey;
  tone?: ReportTone;
  phrase: string;
  continuation?: string;
}) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <ReportSeverityIcon
        severity={severity}
        tone={tone}
        className={cn("shrink-0", (tone ?? severity) === "warn" ? "mt-1" : "mt-0.5")}
      />
      <span>
        <span className={cn("font-medium", SEVERITY_TEXT[tone ?? severity])}>{phrase}</span>
        {continuation ? <span className="text-text-bright"> — {continuation}</span> : null}
      </span>
    </p>
  );
}

/**
 * A finding other than the one in the headline. Fixed columns so consecutive
 * lines start on the same vertical.
 */
export function ReportFindingLine({
  severity,
  tone,
  type,
  text,
  bright,
}: {
  severity: ReportSeverityKey;
  tone?: ReportTone;
  type: string;
  text: string;
  bright?: boolean;
}) {
  return (
    <p className="grid grid-cols-[1rem_4.5rem_minmax(0,1fr)] items-start gap-x-2">
      <ReportSeverityIcon severity={severity} tone={tone} className="mt-0.5" />
      <span className="mt-px text-xs uppercase tracking-wide text-text-dimmed">{type}</span>
      <span className={cn("-mt-0.5 text-sm", bright ? "text-text-bright" : "text-text-dimmed")}>
        {text}
      </span>
    </p>
  );
}

// --- prose highlighting -----------------------------------------------------

/**
 * Highlight rules for report prose. Quantities render bright and tabular,
 * entities mono, verdict phrases bright and medium, everything else dimmed.
 * Colour stays reserved for severity, so emphasis here is weight only.
 */
const QUANTITY_RE = /~?\d[\d,.]*\s?(?:%|×|\/min|ms\b|s\b|min\b|h\b)?/;

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
              <span key={i} className="font-medium text-text-bright">
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
 * A labelled block of lines. The label sits in its own column so the lines hang
 * together as one indented paragraph.
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

// --- footer -----------------------------------------------------------------

// The footer vocabulary lives in the shared layout spec, so the card and the text
// surfaces classify a code the same way. `action` is a primary button, `docs` the
// docs button, `reference` a text link because a button would promise an action,
// and `note` is prose for an option stated rather than offered.
/**
 * The recovery-watch offer. No report emits it; the card adds it. Two codes
 * because it is phrased differently when it is the only thing on offer.
 */
export const FOOTER_WATCH_CODE = "watch_recovery";

/** A dimmed line that accompanies a row entry. */
const FOOTER_NOTE_LINES: Record<string, string> = {
  check_control_plane: "There's nothing to fix on your side.",
};

/** One resolved footer entry: the code it came from, and what it renders as. */
export type ReportFooterItem = { code: string; node: ReactNode };

function isRowEntry(item: ReportFooterItem): boolean {
  const style = reportFooterStyle(item.code);
  return style === "action" || style === "docs" || style === "reference";
}

/**
 * The footer: a "Next steps" heading, the controls in one wrapping row, and
 * stated options as a dimmed line under it.
 */
export function ReportFooterLine({ items }: { items: ReportFooterItem[] }) {
  const entries = items.filter((item) => item.node);
  if (entries.length === 0) return null;

  const row = entries.filter(isRowEntry);
  const noteLines = entries
    .map((item) => FOOTER_NOTE_LINES[item.code])
    .filter((line): line is string => Boolean(line));
  const rest = entries.filter((item) => !isRowEntry(item));

  return (
    <div className="space-y-2 border-t border-grid-bright pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">
        {REPORT_LABELS.nextSteps}
      </h4>
      {row.length > 0 ? (
        // text-xs so a text link in the row (a cited reference) sits at the
        // same size as the buttons beside it.
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {row.map((item, i) => (
            <Fragment key={i}>{item.node}</Fragment>
          ))}
        </div>
      ) : null}
      {rest.length > 0 || noteLines.length > 0 ? (
        <p className="text-sm leading-6 text-text-dimmed">
          {noteLines.join(" ")}
          {noteLines.length > 0 && rest.length > 0 ? " " : null}
          {rest.map((item, i) => (
            <Fragment key={i}>
              {i > 0 ? " " : null}
              {item.node}
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A footer entry that only cites a place to look. Underlined text, never a
 * button: a button promises something happens here.
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
      // The app's link token and the app-wide external-link marker.
      className="text-text-link underline decoration-text-link/40 underline-offset-2 transition hover:decoration-text-link"
    >
      {children}
      {external ? (
        <ArrowUpRightIcon className="ml-0.5 inline-block size-3.5 align-[-0.15em] text-text-dimmed" />
      ) : null}
    </a>
  );
}

/** A footer entry that states an option instead of offering one. */
export function ReportFooterNote({ children }: { children: ReactNode }) {
  return <span className="text-text-dimmed">{children}</span>;
}

/**
 * Keeps an `h-6` control on the text baseline inside the footer sentence without
 * stretching the line it sits on.
 */
const INLINE_CONTROL = "inline-flex align-middle";

/** An in-app footer action. */
export function ReportFooterAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <span className={INLINE_CONTROL}>
      <Button variant="primary/small" onClick={onClick}>
        {children}
      </Button>
    </span>
  );
}

/** A footer action that lives at a URL: the same button, as a link. */
export function ReportFooterActionLink({
  href,
  docs,
  children,
}: {
  href: string;
  docs?: boolean;
  children: ReactNode;
}) {
  const external = /^https?:\/\//i.test(href);
  return (
    <span className={INLINE_CONTROL}>
      <LinkButton
        to={href}
        variant={docs ? "docs/small" : "primary/small"}
        LeadingIcon={docs ? BookOpenIcon : undefined}
        TrailingIcon={!docs && external ? ArrowUpRightIcon : undefined}
      >
        {children}
      </LinkButton>
    </span>
  );
}

/** Where the snapshot came from, in the report's own URI vocabulary. */
export function ReportProvenance({ uri }: { uri: string }) {
  return <div className="break-all font-mono text-[10px] text-text-faint">{uri}</div>;
}

// --- sparkline --------------------------------------------------------------

/** The fixed sparkline column. Keeps every sparkline aligned. */
const SPARK_WIDTH_CLASS = "w-[5.5rem]";

/** The chart's own width; the trailing peak label uses the column's remainder. */
const SPARK_WIDTH = 56;

type ReportSparkDatum = { count: number; date: Date | null; hot: boolean };

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
        {entry.date ? (
          <Header3 className="border-b border-b-border-bright pb-2">
            {formatDateTime(entry.date, "UTC", [], false, true)}
          </Header3>
        ) : null}
        <div className="mt-2 text-xs tabular-nums text-text-bright">{formatPoint(entry.count)}</div>
        {entry.hot ? <div className="mt-1 text-xs text-warning">in the anomaly window</div> : null}
      </div>
    </TooltipPortal>
  );
}

/**
 * A metric's series as an `ActivityBarChart`. Bars inside the anomaly window paint
 * at full strength and the rest recede to a tint of the same colour, so the breach
 * reads as one chart changing intensity rather than a second series.
 */
function ReportSparkline({
  points,
  severity,
  /** Minutes the whole series covers. Turns a bar into its tooltip time. */
  windowMinutes,
  /**
   * Length of the anomaly window when it runs to the end of the series. The
   * matching trailing bars paint at full strength.
   */
  anomalyMinutes,
  /** When the series ends, from the report's `generatedAt`. Turns a bar into a time. */
  seriesEndMs,
  /** The metric's own formatter, used by the tooltip and the peak label. */
  formatPoint,
  label,
  className,
}: {
  points: number[];
  severity: ReportSeverityKey;
  windowMinutes: number;
  anomalyMinutes?: number;
  seriesEndMs: number | null;
  formatPoint: (value: number) => string;
  label: string;
  className?: string;
}) {
  const bars = condense(points);
  // The view model carries buckets, not timestamps, so spread them back from the
  // series' end. Never from the renderer's clock: see `report-spark.ts`.
  const times = barTimesMs(bars.length, windowMinutes, seriesEndMs);
  const hotBars = hotBarCount(bars.length, windowMinutes, anomalyMinutes);

  const data: ReportSparkDatum[] = bars.map((count, i) => ({
    count,
    date: times[i] === null ? null : new Date(times[i]!),
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
 * Label, value, delta and sparkline in fixed columns, so every row's label and
 * chart start on the same vertical whatever the value's width.
 */
/**
 * Below a 19rem container the fixed tracks no longer fit beside the value, so the
 * sparkline drops to its own line. The columns never change, so the value, delta
 * and note stay on the same verticals at every panel width.
 */
const METRIC_ROW_CLASS =
  "grid grid-cols-[6rem_minmax(0,1fr)_2.75rem_5.5rem] items-center gap-x-2 @max-[19rem]:grid-cols-[6rem_minmax(0,1fr)_2.75rem] @max-[19rem]:gap-y-1.5";

/** The sparkline cell: its own full-width line once the row goes narrow. */
const SPARK_CELL_CLASS = "@max-[19rem]:col-span-3 @max-[19rem]:justify-self-end";

// Labels are never truncated: the column fits the common ones and anything
// longer wraps.
const LABEL_CLASS = "text-xs uppercase leading-tight tracking-wide text-text-dimmed";

/** A metric's movement against its baseline. Direction is always an arrow. */
export type ReportDelta = { text: string; dir: "up" | "down" | "flat" };

export function ReportMetricRow({
  label,
  value,
  severity,
  /** A composite metric's parts, indented under it as their own rows. */
  subRows,
  /** The movement against the baseline. */
  delta,
  /**
   * The row's aside, such as its baseline. It goes in a tooltip because as
   * trailing text it broke the sparkline column and read like part of the value.
   */
  note,
  /** The finding-explaining row's annotation. Joins `note` in the info tooltip. */
  heroNote,
  series,
  windowMinutes,
  anomalyMinutes,
  seriesEndMs,
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
  seriesEndMs: number | null;
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
            seriesEndMs={seriesEndMs}
            formatPoint={formatPoint}
            label={label}
            className={SPARK_CELL_CLASS}
          />
        ) : (
          // Keeps the column occupied so a series-less metric doesn't pull the
          // rows out of alignment.
          <span aria-hidden className="@max-[19rem]:hidden" />
        )}
      </li>

      {(subRows ?? []).map((sub) => (
        // A sub-row keeps the grid's columns so its number stays on the same
        // vertical as every other row's value.
        <li key={sub.label} className={METRIC_ROW_CLASS}>
          {/* Indented under the parent label, shallow enough to stay inside the
              6rem label column. */}
          <span className={cn(LABEL_CLASS, "pl-6")}>{sub.label}</span>
          <span className="whitespace-nowrap text-sm tabular-nums text-text-dimmed">
            {sub.value}
          </span>
        </li>
      ))}
    </>
  );
}

/** The metric grid. Rows are `ReportMetricRow`s, which may expand to several. */
export function ReportMetricList({ children }: { children: ReactNode }) {
  // The container the rows measure themselves against.
  return <ul className="@container space-y-2.5">{children}</ul>;
}

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
 * queue metrics `MiniLineChart`; both are router-agnostic. The footer's
 * `LinkButton`s are only ever given external URLs, which it renders as plain
 * anchors — an in-app destination stays an intent, so no router is needed.
 */
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { Children, Fragment, type ReactNode } from "react";
import { Bar, Cell, type TooltipProps } from "recharts";
import { ActivityBarChart } from "~/components/metrics/ActivityBarChart";
import { Button, LinkButton } from "~/components/primitives/Buttons";
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

/**
 * A finding other than the one in the headline: its state, its type, its
 * reason. Fixed columns, so the texts of consecutive lines (execution /
 * liveness) start on the same vertical.
 */
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
    <p className="grid grid-cols-[1rem_4.5rem_minmax(0,1fr)] items-start gap-x-2">
      <ReportSeverityIcon severity={severity} className="mt-0.5" />
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
 *    code", "not a code problem", "not the workers") render bright and medium:
 *    emphasis without another color (color stays reserved for severity).
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

// --- footer -----------------------------------------------------------------

/**
 * How a footer entry renders. One rule, applied by code rather than by URL, so
 * the same code always looks the same in both cards:
 *
 * - `action` — something happens when you press it: the violet primary button.
 *   Still a button when its href leaves the app (contacting us about a limit is
 *   an action even though it opens a web form); the arrow then says it leaves.
 * - `docs` — reading matter we wrote: the docs button.
 * - `reference` — a pointer with no action behind it (a status page): a text
 *   link with the external arrow. A button would promise something happens here.
 * - `note` — an option stated, not offered: prose.
 */
export type ReportFooterStyle = "action" | "docs" | "reference" | "note";

/** Footer codes that state an option rather than offer one. */
const FOOTER_NOTE_CODES = new Set(["nothing_to_do", "do_nothing_drains", "region_failover"]);

/** Footer codes that only cite a place to look, with nothing to press. */
const FOOTER_REFERENCE_CODES = new Set(["check_control_plane", "check_platform_status"]);

/** A doc entry names itself one: `concurrency_docs`, `retries_docs`, … */
const FOOTER_DOCS_SUFFIX = "_docs";

export function reportFooterStyle(code: string): ReportFooterStyle {
  if (FOOTER_NOTE_CODES.has(code)) return "note";
  if (code.endsWith(FOOTER_DOCS_SUFFIX)) return "docs";
  if (FOOTER_REFERENCE_CODES.has(code)) return "reference";
  return "action";
}

/**
 * The footer's recovery-watch offer, which no report emits as a footer entry —
 * the card adds it. Two codes because it is phrased two ways: as an addendum to
 * actions the user was just given, and as the only thing on offer when the
 * report has nothing for them to do.
 */
export const FOOTER_WATCH_CODE = "watch_recovery";
export const FOOTER_WATCH_ONLY_CODE = "watch_recovery_only";

/**
 * A dimmed line that accompanies a row entry — prose the old sentence footer
 * carried around the control, kept as a note under the row.
 */
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
 * The footer. Every report ends the way the diagnosis card does: a "Next
 * steps" section heading, the controls (buttons, docs buttons, cited links) in
 * one wrapping row, and stated options ("or do nothing — …") as a dimmed line
 * under the row.
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
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">Next steps</h4>
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
 * A footer entry that only cites a place to look — a status page, a resolved
 * resource. Underlined text, never a button: a button promises something
 * happens here.
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
      // The app's link token (readable on dark surfaces, theme-remapped) and
      // the app-wide external-link marker — see HelpAndFeedbackPopover.
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

/** An in-app footer action: it happens here, so it gets the primary button. */
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

/**
 * A footer action that lives at a URL: the same button, as a link. `docs` gets
 * the docs variant; an action leaving the app carries the external arrow.
 */
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
        // A sub-row keeps the grid's columns: its label sits in the LABEL
        // column, indented to the middle of the parent label above it, and its
        // number sits in the VALUE column — on the same vertical as the
        // parent's +12/min and every other row's value.
        <li key={sub.label} className={METRIC_ROW_CLASS}>
          {/* Indented under the parent label, but shallow enough that even
              "triggered" stays inside the 7rem label column. */}
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
  return <ul className="space-y-2.5">{children}</ul>;
}

import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  NoSymbolIcon,
  RectangleStackIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import type {
  BatchTaskRunStatus,
  BulkActionStatus,
  BulkActionType,
  ErrorGroupStatus,
  WorkerDeploymentStatus,
} from "@trigger.dev/database";
import type { WaitpointTokenStatus } from "@trigger.dev/core/v3";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { BatchesIcon } from "~/assets/icons/BatchesIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import {
  AgentBadge,
  ConfidenceBadge,
  SeverityBadge,
} from "~/components/dashboard-agent/agent-badges";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { ErrorStatusBadge } from "~/components/errors/ErrorStatusBadge";
import { LogLevel } from "~/components/logs/LogLevel";
import { Badge } from "~/components/primitives/Badge";
import { Callout } from "~/components/primitives/Callout";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { Spinner } from "~/components/primitives/Spinner";
import { RunTimelineEvent, RunTimelineLine } from "~/components/run/RunTimeline";
import { allBatchStatuses, BatchStatusCombo } from "~/components/runs/v3/BatchStatus";
import { BulkActionStatusCombo, BulkActionTypeCombo } from "~/components/runs/v3/BulkAction";
import { deploymentStatuses, DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import {
  allTaskRunAttemptStatuses,
  TaskRunAttemptStatusCombo,
} from "~/components/runs/v3/TaskRunAttemptStatus";
import {
  allTaskRunStatuses,
  runStatusTitle,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { WaitpointStatusCombo } from "~/components/runs/v3/WaitpointStatus";
import {
  allSessionStatuses,
  SessionStatusCombo,
  sessionStatusTitle,
} from "~/components/sessions/v1/SessionStatus";
import { cn } from "~/utils/cn";
import { validLogLevels } from "~/utils/logUtils";
import { StoryGrid, StoryPage, StorySection, StorySubSection } from "../storybook/StoryKit";
import { measureTextContrast, NON_TEXT_THRESHOLD, TEXT_THRESHOLD } from "./contrast";
import { useDocumentIconContrast, useDocumentTheme, useThemeRevision } from "./useThemeRevision";

/* An audit page, not a component gallery. Every entry is something the app
   currently leans on color for - either the color is the only difference between
   two meanings, or the color itself is too low-contrast to see. Each one renders
   five times: once per theme, then once under the "Stronger colors" preference.

   Scope note: the preference used to swap icons as well, and this page was named
   for that. It now only moves colors, so entries whose whole point was a shared
   glyph have been dropped - what remains is either an accent that shifts, or an
   icon/label pair where the label's treatment changes and the icon is the
   context you need to read it.

   The columns work by putting `data-theme` and `data-icon-contrast` on a wrapper
   div. Every rule either preference drives is a plain attribute or descendant
   selector - `:is([data-theme="light"], ...)`, `[data-icon-contrast="true"]
   .contrast-chip`, the `system:` variant, the `dark:` variant - so all of it
   applies from any ancestor, not just <html>. Even the `--chart-2`/`--chart-3`
   override resolves here: it wants both attributes on one element, and the last
   column restates the theme it inherited. */

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/* The four themes side by side, then the preference. Pinning `data-theme` on a
   wrapper works because every theme block is written as a plain attribute
   selector (`:is([data-theme="light"], ...)`) rather than being anchored to
   <html>, and the `dark:` variant is descendant-capable too - so a nested column
   gets the whole token set, not just the custom properties.

   The last column pins no theme of its own: it follows the page's switcher, so
   you can put any theme next to its own high-contrast treatment. */
const THEME_COLUMNS = [
  { key: "light", label: "Light", theme: "light", strongerColors: false },
  { key: "white", label: "White", theme: "white", strongerColors: false },
  { key: "dark", label: "Dark", theme: "dark", strongerColors: false },
  { key: "black", label: "Black", theme: "black", strongerColors: false },
  { key: "stronger", label: "Stronger colors", theme: null, strongerColors: true },
] as const;

type ThemeColumn = (typeof THEME_COLUMNS)[number];

/** Minimum width of one theme column, so a narrow viewport scrolls rather than
 *  crushing five columns of live UI into slivers. */
const THEME_COLUMN_MIN = "13rem";

const THEME_GRID_TEMPLATE = `repeat(5, minmax(${THEME_COLUMN_MIN}, 1fr))`;

/**
 * A cell rendered in one theme's context. The four fixed columns restate the
 * theme; the preference column takes whatever the page is on.
 */
function ThemeCell({
  column,
  className,
  children,
}: {
  column: ThemeColumn;
  className?: string;
  children: ReactNode;
}) {
  const documentTheme = useDocumentTheme();
  return (
    <div
      data-theme={column.theme ?? documentTheme}
      data-icon-contrast={column.strongerColors ? "true" : "false"}
      // An explicit surface, not the page background: statuses live in cards and
      // tables, and the measured ratios need a known backdrop.
      className={cn("min-w-0 bg-background-bright", className)}
    >
      {children}
    </div>
  );
}

/** The five column labels, above a block's cells. */
function ThemeColumnLabels({ leading }: { leading?: ReactNode }) {
  return (
    <>
      {leading}
      {THEME_COLUMNS.map((column) => (
        <span key={column.key} className="truncate text-xxs uppercase text-text-dimmed">
          {column.label}
        </span>
      ))}
    </>
  );
}

/**
 * One audited pattern. `where` is the file (or files) it lives in, `note` says
 * what the color is carrying. The children render once per column.
 */
function Audit({
  title,
  where,
  note,
  children,
}: {
  title: string;
  where: string[];
  note: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-sm border border-grid-dimmed">
      <div className="space-y-1 border-b border-grid-dimmed bg-background-dimmed px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Header3>{title}</Header3>
          {where.map((file) => (
            <CopyableText key={file} value={file} className="font-mono text-xs text-text-dimmed" />
          ))}
        </div>
        <Paragraph variant="extra-small">{note}</Paragraph>
      </div>
      <div className="overflow-x-auto">
        {/* Labels and cells are two grids on one template rather than a subgrid,
            so `divide-x` can hang off the cell row alone - as one grid the label
            strip counts as a child and pushes a stray rule onto the first cell. */}
        <div
          className="grid border-b border-grid-dimmed bg-background-dimmed [&>span]:px-3 [&>span]:py-1"
          style={{ gridTemplateColumns: THEME_GRID_TEMPLATE }}
        >
          <ThemeColumnLabels />
        </div>
        <div
          className="grid divide-x divide-grid-dimmed"
          style={{ gridTemplateColumns: THEME_GRID_TEMPLATE }}
        >
          {THEME_COLUMNS.map((column) => (
            <ThemeCell key={column.key} column={column} className="p-3">
              {children}
            </ThemeCell>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A vertical stack, the way statuses sit in a list. */
function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col items-start gap-2", className)}>{children}</div>;
}

/** A horizontal run, for icon-only sets. */
function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>;
}

/**
 * A stand-in for a table row. Statuses almost never appear alone in the app -
 * they sit in a list where the neighbouring rows are the only thing telling you
 * what "different" looks like.
 */
function MockRows({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-hidden rounded-sm border border-grid-dimmed">
      <div
        className="grid gap-x-3 border-b border-grid-dimmed bg-background-hover px-2.5 py-1.5"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map((column) => (
          <span key={column} className="truncate text-xxs uppercase text-text-dimmed">
            {column}
          </span>
        ))}
      </div>
      {rows.map((cells, index) => (
        <div
          key={index}
          className="grid items-center gap-x-3 border-b border-grid-dimmed px-2.5 py-1.5 text-sm last:border-b-0"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {cells.map((cell, cellIndex) => (
            <div key={cellIndex} className="min-w-0 truncate">
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Measured contrast
// ---------------------------------------------------------------------------

type ContrastEntry = {
  /** What to render the sample in: either a token name or a utility class. */
  token?: string;
  className?: string;
  /** Where the app uses it. */
  usedBy: string;
};

/** Name+usage, fill, ratio, verdict - wide enough that "passes 4.5:1" doesn't wrap. */
/* Token details on the left, then Fill / Ratio / Verdict repeated for each of
   the four themes and once more for the preference - sixteen columns in one flat
   grid, so a sub-column lines up with its header all the way down. Wide by
   design: the whole point is one token against every background at once, so the
   table scrolls sideways rather than compressing. */
const CONTRAST_TOKEN_COL = "minmax(12rem, 1.2fr)";
/** Fill, Ratio, Verdict. Verdict is widest - it carries "passes 4.5:1". */
const CONTRAST_SUB_COLS = "2.25rem 3.5rem 4.25rem";
const CONTRAST_GRID_TEMPLATE = `${CONTRAST_TOKEN_COL} repeat(5, ${CONTRAST_SUB_COLS})`;

/** Left edge of each theme group, so the three readings read as one band. */
const THEME_GROUP_EDGE = "border-l border-grid-dimmed";

/**
 * The three readings for one token in one theme.
 *
 * `display: contents` on the themed wrapper is doing the work here: it puts
 * `data-theme` in the ancestor chain - so the tokens, the `dark:` variant and
 * the preference all resolve to that theme - while leaving the three cells as
 * direct grid items of the row, which is what keeps them aligned under their
 * headers. A wrapper with a box would nest them one level down and break the
 * grid.
 */
function ContrastCells({ entry, column }: { entry: ContrastEntry; column: ThemeColumn }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const revision = useThemeRevision();
  const documentTheme = useDocumentTheme();
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!fillRef.current) return;
    setRatio(measureTextContrast(fillRef.current));
  }, [revision, entry.token, entry.className]);

  /* Under the 3:1 floor the value is unusable for anything, text or not - call
     it out in bold red so the failures pull the eye down a long table. The
     verdict words carry the same information, so the red is reinforcement
     rather than the signal. */
  const fails = ratio !== null && ratio < NON_TEXT_THRESHOLD;
  const cell = "flex items-center bg-background-bright py-1";

  return (
    <div
      className="contents"
      data-theme={column.theme ?? documentTheme}
      data-icon-contrast={column.strongerColors ? "true" : "false"}
    >
      {/* The fill block is also the measured sample: it carries the token as its
          own `color`, which is what the ratio reads, and as its background,
          which is the shape non-text contrast is judged on. For a raw utility
          the class sets `color`, so the fill comes from currentcolor instead. */}
      <div className={cn(cell, THEME_GROUP_EDGE, "px-1.5")}>
        <div
          ref={fillRef}
          className={cn("h-4 w-full rounded-xs border border-grid-bright", entry.className)}
          style={{
            color: entry.token ? `var(${entry.token})` : undefined,
            backgroundColor: entry.token ? `var(${entry.token})` : "currentcolor",
          }}
        />
      </div>
      <div
        className={cn(
          cell,
          "justify-end font-mono text-xs tabular-nums",
          fails ? "font-bold text-error" : "text-text-bright"
        )}
      >
        {ratio === null ? "\u2014" : ratio.toFixed(2)}
      </div>
      <div
        className={cn(
          cell,
          "justify-end pr-2 text-xxs",
          fails ? "font-bold text-error" : "text-text-dimmed"
        )}
      >
        {ratio === null
          ? ""
          : fails
            ? "fails 3:1"
            : ratio < TEXT_THRESHOLD
              ? "3:1 only"
              : "passes 4.5:1"}
      </div>
    </div>
  );
}

function ContrastRow({ entry }: { entry: ContrastEntry }) {
  const name = entry.token ? entry.token.replace("--color-", "") : entry.className;

  return (
    <div
      className="grid items-stretch border-b border-grid-dimmed last:border-b-0"
      style={{ gridTemplateColumns: CONTRAST_GRID_TEMPLATE }}
    >
      <div className="min-w-0 self-center py-1 pr-2">
        <span className="block truncate font-mono text-xs text-text-bright">{name}</span>
        <span className="block truncate text-xxs text-text-dimmed">{entry.usedBy}</span>
      </div>
      {THEME_COLUMNS.map((column) => (
        <ContrastCells key={column.key} entry={entry} column={column} />
      ))}
    </div>
  );
}

/** Two header rows on the same template: theme names spanning their three
 *  readings, then the readings themselves. */
function ContrastHeader() {
  return (
    <div className="text-xxs uppercase text-text-dimmed">
      <div className="grid" style={{ gridTemplateColumns: CONTRAST_GRID_TEMPLATE }}>
        <span className="truncate pr-2">Token &amp; where it's used</span>
        {THEME_COLUMNS.map((column) => (
          <span
            key={column.key}
            className={cn("col-span-3 truncate px-1.5 text-text-bright", THEME_GROUP_EDGE)}
          >
            {column.label}
          </span>
        ))}
      </div>
      <div
        className="grid border-b border-grid-bright pb-1"
        style={{ gridTemplateColumns: CONTRAST_GRID_TEMPLATE }}
      >
        <span />
        {THEME_COLUMNS.map((column) => (
          <Fragment key={column.key}>
            <span className={cn("truncate px-1.5", THEME_GROUP_EDGE)}>Fill</span>
            <span className="truncate text-right">Ratio</span>
            <span className="truncate pr-2 text-right">Verdict</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ContrastTable({ entries }: { entries: ContrastEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <ContrastHeader />
      {entries.map((entry) => (
        <ContrastRow key={entry.token ?? entry.className} entry={entry} />
      ))}
    </div>
  );
}

const STATUS_TOKENS: ContrastEntry[] = [
  { token: "--color-success", usedBy: "Completed / Deployed / Enabled, timeline bars" },
  { token: "--color-warning", usedBy: "Partial failure, paused queues, warning callouts" },
  { token: "--color-error", usedBy: "Failed / Crashed / Aborted, error callouts, trace bars" },
  { token: "--color-pending", usedBy: "Executing / Dequeued / In progress spinners" },
  { token: "--color-text-bright", usedBy: "Primary body text" },
  { token: "--color-text-dimmed", usedBy: "Secondary text, Idle chips, neutral timeline" },
  { token: "--color-text-faint", usedBy: "Queued / Delayed / Canceled / Expired statuses" },
  { token: "--color-text-link", usedBy: "TextLink, markdown prose links" },
  { token: "--color-primary", usedBy: "Primary buttons" },
];

const ENVIRONMENT_TOKENS: ContrastEntry[] = [
  { token: "--color-dev", usedBy: "Development env label + icon" },
  { token: "--color-staging", usedBy: "Staging env label + icon" },
  { token: "--color-preview", usedBy: "Preview env label + icon, branch labels" },
  { token: "--color-prod", usedBy: "Production env label + icon" },
];

/** The nav/section accent set, in the order tailwind.css declares it. */
const ACCENT_TOKENS: ContrastEntry[] = [
  { token: "--color-tasks", usedBy: "Tasks nav + standard task icon" },
  { token: "--color-runs", usedBy: "Runs nav, run metrics" },
  { token: "--color-batches", usedBy: "Batches nav" },
  { token: "--color-schedules", usedBy: "Schedules nav, scheduled task icon" },
  { token: "--color-queues", usedBy: "Queues nav, queue charts" },
  { token: "--color-query", usedBy: "Query span icon" },
  { token: "--color-metrics", usedBy: "Metrics nav" },
  { token: "--color-customDashboards", usedBy: "Custom dashboards nav" },
  { token: "--color-deployments", usedBy: "Deployments nav" },
  { token: "--color-concurrency", usedBy: "Concurrency nav" },
  { token: "--color-limits", usedBy: "Limits nav" },
  { token: "--color-regions", usedBy: "Regions nav" },
  { token: "--color-logs", usedBy: "Logs nav" },
  { token: "--color-tests", usedBy: "Test nav" },
  { token: "--color-apiKeys", usedBy: "API keys nav" },
  { token: "--color-environmentVariables", usedBy: "Environment variables nav" },
  { token: "--color-alerts", usedBy: "Alerts nav" },
  { token: "--color-projectSettings", usedBy: "Project settings nav" },
  { token: "--color-orgSettings", usedBy: "Org settings nav" },
  { token: "--color-docs", usedBy: "Docs links, docs callouts" },
  { token: "--color-bulkActions", usedBy: "Bulk actions nav" },
  { token: "--color-aiPrompts", usedBy: "Prompts nav" },
  { token: "--color-aiMetrics", usedBy: "AI metrics nav" },
  { token: "--color-errors", usedBy: "Errors nav" },
  { token: "--color-agents", usedBy: "Agents nav, agent span titles" },
  { token: "--color-sessions", usedBy: "Sessions nav" },
  { token: "--color-playgrounds", usedBy: "Playgrounds nav" },
  { token: "--color-models", usedBy: "Models nav" },
  { token: "--color-previewBranches", usedBy: "Preview branches nav" },
];

/**
 * Raw palette utilities used straight from components. These sit outside the
 * themable layer entirely: they are the same color in all four themes and the
 * accessibility preference can't touch them.
 */
const RAW_PALETTE_CLASSES: ContrastEntry[] = [
  { className: "text-amber-300", usedBy: "TaskRunStatus.tsx — Paused" },
  { className: "text-amber-400", usedBy: "SpanTitle.tsx / RunIcon.tsx — WARN spans and logs" },
  { className: "text-amber-500", usedBy: "TaskRunStatus.tsx — Pending version" },
  { className: "text-blue-400", usedBy: "logUtils.ts — INFO chip; ErrorStatusBadge.tsx — Ignored" },
  {
    className: "text-blue-500",
    usedBy: "BatchStatus.tsx Processing, WaitpointStatus.tsx Waiting, span titles, Badge.tsx",
  },
  { className: "text-purple-400", usedBy: "logUtils.ts — TRACE chip" },
  { className: "text-charcoal-400", usedBy: "logUtils.ts — DEBUG chip" },
  { className: "text-indigo-500", usedBy: "BulkAction.tsx — Replay" },
  { className: "text-rose-500", usedBy: "BulkAction.tsx — Cancel" },
  { className: "text-sky-500", usedBy: "RunIcon.tsx / SpanTitle.tsx — wait and waitpoint spans" },
  { className: "text-green-500", usedBy: "CopyButton.tsx / CopyableText.tsx / Table.tsx — copied" },
  { className: "text-yellow-500", usedBy: "RunTimeline.tsx — fallback event marker" },
];

/** Chart/sparkbar series for run statuses - judged at 3:1, not 4.5:1. */
const RUN_STATUS_CHART_TOKENS: ContrastEntry[] = [
  { token: "--color-run-pending", usedBy: "Queued" },
  { token: "--color-run-delayed", usedBy: "Delayed" },
  { token: "--color-run-pending-version", usedBy: "Pending version" },
  { token: "--color-run-waiting-for-deploy", usedBy: "Waiting for deploy" },
  { token: "--color-run-dequeued", usedBy: "Dequeued" },
  { token: "--color-run-executing", usedBy: "Executing" },
  { token: "--color-run-retrying-after-failure", usedBy: "Reattempting" },
  { token: "--color-run-waiting-to-resume", usedBy: "Waiting" },
  { token: "--color-run-paused", usedBy: "Paused" },
  { token: "--color-run-canceled", usedBy: "Canceled" },
  { token: "--color-run-expired", usedBy: "Expired" },
  { token: "--color-run-completed-successfully", usedBy: "Completed" },
  { token: "--color-run-completed-with-errors", usedBy: "Failed" },
  { token: "--color-run-interrupted", usedBy: "Interrupted" },
  { token: "--color-run-system-failure", usedBy: "System failure" },
  { token: "--color-run-crashed", usedBy: "Crashed" },
  { token: "--color-run-timed-out", usedBy: "Timed out" },
];

const CALLOUT_TOKENS: ContrastEntry[] = [
  { token: "--color-callout-warning-text", usedBy: "Callout body — warning" },
  { token: "--color-callout-error-text", usedBy: "Callout body — error" },
  { token: "--color-callout-success-text", usedBy: "Callout body — success / idea" },
  { token: "--color-callout-docs", usedBy: "Callout icon — docs" },
  { token: "--color-callout-docs-text", usedBy: "Callout body — docs" },
  { token: "--color-callout-pending", usedBy: "Callout icon — pending" },
  { token: "--color-callout-pending-text", usedBy: "Callout body — pending" },
  { token: "--color-callout-pricing", usedBy: "Callout icon — pricing" },
  { token: "--color-callout-pricing-text", usedBy: "Callout body — pricing" },
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The four environment types plus a branch, as the env switcher lists them. */
const ENVIRONMENTS = [
  { type: "DEVELOPMENT" as const },
  { type: "STAGING" as const },
  { type: "PREVIEW" as const },
  { type: "PRODUCTION" as const },
  { type: "PREVIEW" as const, branchName: "feat/checkout-rewrite" },
];

/** The three run statuses that share RectangleStackIcon. */
const STACK_ICON_STATUSES = ["PENDING", "PENDING_VERSION", "DEQUEUED"] as const;

const WAITPOINT_STATUSES: WaitpointTokenStatus[] = ["WAITING", "COMPLETED", "TIMED_OUT"];

const ERROR_GROUP_STATUSES: ErrorGroupStatus[] = ["UNRESOLVED", "RESOLVED", "IGNORED"];

const BULK_ACTION_TYPES: BulkActionType[] = ["REPLAY", "CANCEL"];

const BULK_ACTION_STATUSES: BulkActionStatus[] = ["PENDING", "COMPLETED", "ABORTED"];

/** The queue health labels from the Queues route. Paused and At capacity share
 *  one tint, so color alone can't separate them even before contrast. */
const QUEUE_HEALTH = [
  { label: "Paused", className: "bg-warning/10 text-warning" },
  { label: "At capacity", className: "bg-warning/10 text-warning" },
  { label: "Backlogged", className: "bg-blue-500/10 text-blue-500" },
  { label: "Active", className: "bg-success/10 text-success" },
  { label: "Idle", className: "bg-charcoal-500/10 text-text-dimmed" },
];

/** Copied from the Queues route so the chip can be shown here without exporting
 *  it. Keep in sync if QUEUE_HEALTH_STYLES changes. */
function QueueHealthChip({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "contrast-chip inline-flex w-fit items-center rounded px-2 py-0.5 text-xs font-medium",
        className
      )}
    >
      {label}
    </span>
  );
}

const TRACE_BAR_STATES = [
  { label: "Completed", className: "bg-success" },
  { label: "In progress", className: "bg-blue-500" },
  { label: "Failed", className: "bg-error" },
  { label: "Warning level", className: "bg-amber-400" },
  { label: "Canceled", className: "bg-surface-control" },
  { label: "Non-primary span", className: "bg-surface-control-active" },
];

const CHART_SERIES = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

/** Five nav items with their real icons and accent classes, as sideMenuSections
 *  declares them. Classes rather than inline styles on purpose: the monochrome
 *  override is a stylesheet rule, and an inline color would out-specify it. */
const NAV_ITEMS = [
  { label: "Runs", icon: RunsIcon, activeIconColor: "text-runs" },
  { label: "Batches", icon: BatchesIcon, activeIconColor: "text-batches" },
  { label: "Schedules", icon: ClockIcon, activeIconColor: "text-schedules" },
  { label: "Queues", icon: QueuesIcon, activeIconColor: "text-queues" },
  { label: "Deploys", icon: DeploymentsIcon, activeIconColor: "text-deployments" },
];

const AGENT_STATUS_SERIES = [
  { label: "Completed / Closed", token: "--color-success" },
  { label: "Running / Active", token: "--color-pending" },
  { label: "Failed", token: "--color-error" },
  { label: "Canceled / Expired", token: "--color-text-dimmed" },
];

// ---------------------------------------------------------------------------
// Palette reference (formerly the Theme tokens page)
// ---------------------------------------------------------------------------

/* The raw semantic layer: surfaces, lines and the neutral ramp. These aren't
   accents carrying meaning, so they get swatches rather than a measured verdict
   - what matters is the value itself, and the theme switcher above shows each
   theme's in place. */

const BACKGROUND_TOKENS = [
  "--color-background-deep",
  "--color-background-dimmed",
  "--color-background-bright",
  "--color-background-hover",
  "--color-background-raised",
  "--color-secondary",
  "--color-tertiary",
  "--color-surface-control",
  "--color-surface-control-hover",
  "--color-surface-control-active",
  "--color-input-bg",
];

const LINE_TOKENS = [
  "--color-grid-dimmed",
  "--color-grid-bright",
  "--color-border-bright",
  "--color-border-brighter",
  "--color-border-brightest",
];

const BODY_TEXT_TOKENS = [
  "--color-text-bright",
  "--color-text-dimmed",
  "--color-text-faint",
  "--color-text-link",
];

const CHARCOAL_SCALE = [
  100, 200, 300, 400, 500, 550, 600, 650, 700, 750, 775, 800, 850, 900, 950, 1000,
].map((stop) => `--color-charcoal-${stop}`);

function Swatch({ token, tall }: { token: string; tall?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn("rounded-sm border border-grid-bright", tall ? "h-16" : "h-10")}
        style={{ backgroundColor: `var(${token})` }}
      />
      <Paragraph variant="extra-extra-small" className="font-mono text-text-dimmed">
        {token.replace("--color-", "")}
      </Paragraph>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart examples
// ---------------------------------------------------------------------------

/* Invented numbers, shaped like a week of runs so the stack heights vary the way
   a real chart's would. Both charts share one series list, so the same four
   accents can be compared as fills and as strokes. */
/* Three bars, not a full week: each chart renders five times across the row, so a
   narrow column needs stacks wide enough to read the four fills against each
   other rather than a dense week of slivers. */
const CHART_WEEK = [
  { day: "Mon", completed: 186, queued: 38, delayed: 22, failed: 24 },
  { day: "Tue", completed: 205, queued: 44, delayed: 15, failed: 18 },
  { day: "Wed", completed: 164, queued: 29, delayed: 34, failed: 41 },
];

/* A deliberate mix of how the tokens behave, so the columns show the range
   rather than a best case: queues-chart moves on every theme, success and
   warning only on the dark ones (Light and White already darken them to the
   high-contrast value), and error never moves. */
const CHART_SERIES_TOKENS = [
  { key: "completed", label: "Completed", color: "var(--color-success)" },
  { key: "queued", label: "Queued", color: "var(--color-queues-chart)" },
  { key: "delayed", label: "Delayed", color: "var(--color-warning)" },
  { key: "failed", label: "Failed", color: "var(--color-error)" },
] as const;

const AXIS_TICK = { fontSize: 10, fill: "var(--color-text-dimmed)" } as const;
const CHART_MARGIN = { top: 4, right: 4, bottom: 0, left: -18 } as const;

/** Swatch legend, so a series can be named without a tooltip. */
function SeriesLegend() {
  return (
    <Row className="gap-x-3 gap-y-1 pt-2">
      {CHART_SERIES_TOKENS.map((series) => (
        <span key={series.key} className="flex items-center gap-1.5">
          <span
            className="size-2.5 shrink-0 rounded-xs"
            style={{ backgroundColor: series.color }}
          />
          <span className="text-xxs text-text-dimmed">{series.label}</span>
        </span>
      ))}
    </Row>
  );
}

/* Animation is off on both: each renders twice on this page, and a chart that
   grows out of the axis on every theme switch makes the two columns hard to
   compare mid-flight. */

/** Stacked bars, so the four fills meet edge to edge with no gap to separate them. */
function StackedBarExample() {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={CHART_WEEK} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} stroke="var(--color-grid-dimmed)" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tick={AXIS_TICK} />
          <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} width={40} />
          {CHART_SERIES_TOKENS.map((series, index) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              stackId="runs"
              fill={series.color}
              isAnimationActive={false}
              radius={index === CHART_SERIES_TOKENS.length - 1 ? [2, 2, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The same series as strokes, where a 2px line has far less area than a bar. */
function LineExample() {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={CHART_WEEK} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} stroke="var(--color-grid-dimmed)" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tick={AXIS_TICK} />
          <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} width={40} />
          {CHART_SERIES_TOKENS.map((series) => (
            <Line
              key={series.key}
              type="monotone"
              dataKey={series.key}
              stroke={series.color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Story_() {
  const documentIconContrast = useDocumentIconContrast();

  return (
    <StoryPage
      title="Colors"
      componentNames={["tailwind.css"]}
      description="The palette, and every accent whose contrast is worth checking. Each block renders in all four themes side by side, then once more under the “Stronger colors” preference, which follows the theme switcher above — so you can put any theme next to its own high-contrast treatment. Ratios are measured live off the DOM, against that column's own background."
    >
      {documentIconContrast && (
        <Callout variant="warning">
          The header's “Stronger colors” switch is on, so the four theme columns already show the
          high-contrast treatment and match the last one. Turn it off to compare them.
        </Callout>
      )}

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="1. Palette"
        description="The semantic layer these accents are built on. Surfaces, lines and the neutral ramp carry no meaning of their own, so they're shown as plain swatches following the theme switcher rather than measured against a floor."
      >
        <StorySubSection title="Backgrounds & surfaces">
          <StoryGrid min="10rem">
            {BACKGROUND_TOKENS.map((token) => (
              <Swatch key={token} token={token} tall />
            ))}
          </StoryGrid>
        </StorySubSection>

        <StorySubSection title="Grid lines & borders">
          <StoryGrid min="10rem">
            {LINE_TOKENS.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </StoryGrid>
        </StorySubSection>

        <StorySubSection title="Body text">
          <div className="flex flex-col gap-2 rounded-sm border border-grid-dimmed p-4">
            {BODY_TEXT_TOKENS.map((token) => (
              <div key={token} className="flex items-baseline gap-4">
                <span className="text-base" style={{ color: `var(${token})` }}>
                  The quick brown fox jumps over the lazy dog
                </span>
                <Paragraph variant="extra-extra-small" className="font-mono text-text-dimmed">
                  {token.replace("--color-", "")}
                </Paragraph>
              </div>
            ))}
          </div>
        </StorySubSection>

        <StorySubSection title="Charcoal scale">
          <StoryGrid min="7rem">
            {CHARCOAL_SCALE.map((token) => (
              <Swatch key={token} token={token} />
            ))}
          </StoryGrid>
        </StorySubSection>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="2. Measured contrast"
        description={`Each sample's own computed color against the surface behind it. 3:1 is the floor for icons, chart series and other non-text marks; 4.5:1 is the floor for the status labels next to them. Ratios re-measure when the theme, the interface-contrast slider or the preference changes.`}
      >
        <StorySubSection title="Status & text tokens">
          <Audit
            title="Status and text accents"
            where={["tailwind.css"]}
            note="The four status tokens carry every run, deployment, batch, waitpoint and queue state in the app, plus the timeline and trace bars."
          >
            <ContrastTable entries={STATUS_TOKENS} />
          </Audit>
        </StorySubSection>

        <StorySubSection title="Environment tokens">
          <Audit
            title="Environment accents"
            where={["tailwind.css", "EnvironmentLabel.tsx"]}
            note="Staging is the one env token that still differs per mode. Preview and its branch labels are blue in every theme now, so they read the same at both ends of the `system` setting."
          >
            <ContrastTable entries={ENVIRONMENT_TOKENS} />
          </Audit>
        </StorySubSection>

        <StorySubSection title="Navigation & section accents">
          <Audit
            title="Nav icon accents"
            where={["tailwind.css", "sideMenuSections.tsx", "favoritePages.tsx"]}
            note="29 accents, one per nav section. Several land on the same hue (metrics / regions / aiMetrics are all green; concurrency / errors / apiKeys are all amber), so the accent identifies a section only in combination with its icon."
          >
            <ContrastTable entries={ACCENT_TOKENS} />
          </Audit>
        </StorySubSection>

        <StorySubSection title="Raw palette classes (not themed)">
          <Audit
            title="Palette utilities used directly in components"
            where={[
              "TaskRunStatus.tsx",
              "BatchStatus.tsx",
              "WaitpointStatus.tsx",
              "SpanTitle.tsx",
              "RunIcon.tsx",
              "logUtils.ts",
              "BulkAction.tsx",
            ]}
            note="These bypass the semantic layer: identical in all four themes, and the preference can't move them. The right-hand column is deliberately unchanged here — that's the finding."
          >
            <ContrastTable entries={RAW_PALETTE_CLASSES} />
          </Audit>
        </StorySubSection>

        <StorySubSection title="Run-status chart series">
          <Audit
            title="Run status chart colors"
            where={["tailwind.css", "TaskRunStatus.tsx"]}
            note="17 series on one chart, deliberately spaced within three families (blues, roses, charcoals). Judged at 3:1 against the plot surface — and, separately, against each other."
          >
            <ContrastTable entries={RUN_STATUS_CHART_TOKENS} />
          </Audit>
        </StorySubSection>

        <StorySubSection title="Callout accents">
          <Audit
            title="Callout text and icon accents"
            where={["Callout.tsx", "tailwind.css"]}
            note="Measured against this card, not the callout's own tint — the real ratio inside a callout is a little lower for the text tokens and a little higher for the icons."
          >
            <ContrastTable entries={CALLOUT_TOKENS} />
          </Audit>
        </StorySubSection>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="3. Icon and label pairs"
        description="Combos where the preference changes both halves: the label drops to the surrounding text color (system-mono-label) and the icon keeps a tint that moves. The icon is here as context for the label, not as the thing being audited — sets that differed only by glyph have been dropped, since the preference no longer touches icons."
      >
        <Audit
          title="Staging and Preview share an icon"
          where={["EnvironmentLabel.tsx", "EnvironmentIcons.tsx"]}
          note={
            <>
              <code className="font-mono">DeployedEnvironmentIconSmall</code> is returned for both{" "}
              <code className="font-mono">STAGING</code> and{" "}
              <code className="font-mono">PREVIEW</code>. Orange vs blue now separates them at a
              glance, but both labels go monochrome under the preference, leaving the icon tint
              alone to carry it.
            </>
          }
        >
          <Stack>
            {ENVIRONMENTS.map((environment, index) => (
              <EnvironmentCombo key={index} environment={environment} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Three run statuses share RectangleStackIcon"
          where={["TaskRunStatus.tsx"]}
          note="Queued (faint), Pending version (amber-500) and Dequeued (blue) all draw the stack glyph. In the runs table the icon column is the first thing you scan."
        >
          <Stack>
            {STACK_ICON_STATUSES.map((status) => (
              <TaskRunStatusCombo key={status} status={status} />
            ))}
          </Stack>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="4. Colored dots"
        description="A filled circle has no shape to read. Where two dots differ only in fill, the state is unavailable without color — and at 6px the contrast floor is the hardest to clear."
      >
        <Audit
          title="Session statuses"
          where={["SessionStatus.tsx", "SessionsTable.tsx"]}
          note="Active is a pulsing blue dot; Closed and Expired get real glyphs. The dot is the odd one out — and the label beside it goes monochrome under the preference, so the dot's fill is all that's left."
        >
          <Stack>
            {allSessionStatuses.map((status) => (
              <SessionStatusCombo key={status} status={status} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Session statuses in a list"
          where={["SessionsTable.tsx"]}
          note="How the dot actually appears: one narrow column, rows scanned vertically."
        >
          <MockRows
            columns={["Session", "Status", "Started"]}
            rows={allSessionStatuses.map((status) => [
              <span key="id" className="font-mono text-xs text-text-bright">
                session_{status.toLowerCase().slice(0, 4)}9f2
              </span>,
              <SessionStatusCombo key="status" status={status} />,
              <span key="started" className="text-xs text-text-dimmed">
                {sessionStatusTitle(status)} 2m ago
              </span>,
            ])}
          />
        </Audit>

        <Audit
          title="Prompt version dots"
          where={["prompts._index/route.tsx"]}
          note="Green means “running the latest version”, amber means “pinned to an older one”. Identical 6px circles; the meaning lives in a header tooltip."
        >
          <MockRows
            columns={["Prompt", "Version"]}
            rows={[
              [
                <span key="name" className="text-text-bright">
                  summarise-thread
                </span>,
                <span key="version" className="flex items-center gap-2">
                  <span className="size-1.5 shrink-0 rounded-full bg-success" />
                  <span className="text-xs text-text-dimmed">20260814.3</span>
                </span>,
              ],
              [
                <span key="name" className="text-text-bright">
                  classify-intent
                </span>,
                <span key="version" className="flex items-center gap-2">
                  <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                  <span className="text-xs text-text-dimmed">20260731.1</span>
                </span>,
              ],
            ]}
          />
        </Audit>

        <Audit
          title="Connection dots"
          where={["settings.sso/route.tsx", "github.tsx", "vercel.tsx"]}
          note="SSO connections switch a dot between bg-success and bg-text-dimmed; the GitHub and Vercel panels use a bg-success dot inline in a sentence. No glyph, no state word next to the dot itself."
        >
          <Stack>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <span className="size-1.5 rounded-full bg-success" />
              Okta (SAML)
            </span>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <span className="size-1.5 rounded-full bg-text-dimmed" />
              Entra ID (inactive)
            </span>
            <span className="text-sm text-text-bright">
              <span className="mr-2 inline-block size-1.5 rounded-full bg-success align-[0.15em]" />
              Connected to acme-corp/website
            </span>
          </Stack>
        </Audit>

        <Audit
          title="Dev server presence"
          where={["DevPresence.tsx"]}
          note="A pulsing dot in the environment header, plus a text-success / text-error sentence in the panel. The dot is the only signal in the header."
        >
          <Stack>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <PulsingDot />
              Dev server connected
            </span>
            <Paragraph variant="small" className="system-mono-label text-success">
              Your local dev server is connected to Trigger.dev
            </Paragraph>
            <Paragraph variant="small" className="system-mono-label text-error">
              Your local dev server is not connected to Trigger.dev
            </Paragraph>
          </Stack>
        </Audit>

        <Audit
          title="PulsingDot variants"
          where={["PulsingDot.tsx", "runs.$runParam/route.tsx"]}
          note="The primitive defaults to blue-500 and is re-tinted at each call site. The trace view's “live run” indicator hard-codes the same markup inline."
        >
          <Row>
            <PulsingDot />
            <PulsingDot ringClassName="bg-success/50" dotClassName="bg-success" />
            <PulsingDot ringClassName="bg-error/50" dotClassName="bg-error" />
          </Row>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="5. Tinted chips and badges"
        description="Same pill, same size, same weight — the tint and the text color are the only variables. These already opt into the contrast-chip ring, so the right-hand column shows what that ring does at the current interface-contrast setting."
      >
        <Audit
          title="Error group statuses"
          where={["ErrorStatusBadge.tsx"]}
          note="Both prominence levels. Ignored uses raw blue-400/blue-500, so it doesn't follow the semantic layer the other two do."
        >
          <Stack>
            <Row>
              {ERROR_GROUP_STATUSES.map((status) => (
                <ErrorStatusBadge key={status} status={status} />
              ))}
            </Row>
            <Row>
              {ERROR_GROUP_STATUSES.map((status) => (
                <ErrorStatusBadge key={status} status={status} prominence="bright" />
              ))}
            </Row>
          </Stack>
        </Audit>

        <Audit
          title="Queue health"
          where={["queues/route.tsx"]}
          note="Five labels, four tints: Paused and At capacity are both bg-warning/10 text-warning, so color can't separate them even at full contrast. Idle is the only neutral."
        >
          <Stack>
            {QUEUE_HEALTH.map((health) => (
              <QueueHealthChip key={health.label} {...health} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Log level chips"
          where={["LogLevel.tsx", "logUtils.ts", "LogsLevelFilter.tsx"]}
          note="Five levels on the Logs page. TRACE (purple-400), INFO (blue-400) and DEBUG (charcoal-400 on charcoal-700) are raw palette values, so they don't shift for the light themes or the preference. The filter dropdown styles DEBUG differently again."
        >
          <Stack>
            <Row>
              {validLogLevels.map((level) => (
                <LogLevel key={level} level={level} />
              ))}
            </Row>
            <Paragraph variant="extra-extra-small/caps" className="pt-1 text-text-dimmed">
              LogsLevelFilter's own DEBUG style
            </Paragraph>
            <span
              className={cn(
                "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium uppercase",
                "border-border-bright bg-background-raised text-text-dimmed"
              )}
            >
              DEBUG
            </span>
          </Stack>
        </Audit>

        <Audit
          title="Log levels against messages"
          where={["LogsTable.tsx"]}
          note="How the chips read in the list they were drawn for."
        >
          <Stack className="w-full">
            {[
              { level: "INFO" as const, message: "Task hello-world starting" },
              { level: "DEBUG" as const, message: "Resolved queue concurrency limit to 10" },
              { level: "WARN" as const, message: "Retrying after failure (attempt 2 of 3)" },
              { level: "ERROR" as const, message: "fetch failed with status 503" },
              { level: "TRACE" as const, message: "prisma:query SELECT id FROM TaskRun" },
            ].map((row) => (
              <div key={row.level} className="flex w-full items-center gap-2">
                <span className="w-14 shrink-0">
                  <LogLevel level={row.level} />
                </span>
                <span className="truncate font-mono text-xs text-text-dimmed">{row.message}</span>
              </div>
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Badge primitive"
          where={["Badge.tsx"]}
          note="Four of the five variants are blue regardless of meaning — the variant picks a size, not a state. Call sites then override the color (a text-warning or text-error class on an extra-small badge) to mean something."
        >
          <Row>
            <Badge>default</Badge>
            <Badge variant="extra-small">extra-small</Badge>
            <Badge variant="small">small</Badge>
            <Badge variant="outline-rounded">outline</Badge>
            <Badge variant="rounded">rounded</Badge>
            <Badge variant="extra-small" className="text-warning">
              overridden
            </Badge>
            <Badge variant="extra-small" className="text-error">
              overridden
            </Badge>
          </Row>
        </Audit>

        <Audit
          title="Trigger Agent badges"
          where={["agent-badges.tsx"]}
          note="Tones are semantic and every badge already pairs its tone with a glyph — except CategoryBadge and the neutral tone, where the chip is text only."
        >
          <Stack>
            <Row>
              <AgentBadge tone="neutral">neutral</AgentBadge>
              <AgentBadge tone="success">success</AgentBadge>
              <AgentBadge tone="warning">warning</AgentBadge>
              <AgentBadge tone="error">error</AgentBadge>
            </Row>
            <Row>
              <ConfidenceBadge confidence="high" />
              <ConfidenceBadge confidence="medium" />
              <ConfidenceBadge confidence="low" />
            </Row>
            <Row>
              <SeverityBadge severity="info">Informational</SeverityBadge>
              <SeverityBadge severity="warn">Degraded</SeverityBadge>
              <SeverityBadge severity="crit">Critical</SeverityBadge>
            </Row>
          </Stack>
        </Audit>

        <Audit
          title="Callouts"
          where={["Callout.tsx"]}
          note="Every variant has its own icon, so the tint is redundant — the thing to check here is the body text against its own tinted background."
        >
          <Stack className="w-full">
            {(["info", "warning", "error", "success", "docs", "pricing"] as const).map(
              (variant) => (
                <Callout key={variant} variant={variant} className="w-full">
                  {variant} callout — body text on the variant's own tint
                </Callout>
              )
            )}
          </Stack>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="6. Status sets in list context"
        description="The full sets, as they sit in the tables they were drawn for. Under the preference the labels go monochrome and the icon keeps the tint, so these show how much work the glyph is left doing."
      >
        <Audit
          title="Every run status"
          where={["TaskRunStatus.tsx", "TaskRunsTable.tsx"]}
          note="17 statuses, 6 distinct colors, 13 distinct glyphs."
        >
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {allTaskRunStatuses.map((status) => (
              <TaskRunStatusCombo key={status} status={status} />
            ))}
          </div>
        </Audit>

        <Audit
          title="Runs table"
          where={["TaskRunsTable.tsx"]}
          note="Status, environment and machine columns together — three colored signals in one row."
        >
          <MockRows
            columns={["Run", "Env", "Status"]}
            rows={(
              [
                "COMPLETED_SUCCESSFULLY",
                "EXECUTING",
                "PENDING_VERSION",
                "COMPLETED_WITH_ERRORS",
                "CANCELED",
              ] as const
            ).map((status, index) => [
              <span key="id" className="font-mono text-xs text-text-bright">
                run_{runStatusTitle(status).toLowerCase().replace(/\s/g, "")}
              </span>,
              <EnvironmentCombo
                key="env"
                environment={ENVIRONMENTS[index % ENVIRONMENTS.length]}
              />,
              <TaskRunStatusCombo key="status" status={status} />,
            ])}
          />
        </Audit>

        <Audit
          title="Batch statuses"
          where={["BatchStatus.tsx"]}
          note="Five states. Processing and In progress share the Spinner; the other three have their own glyphs."
        >
          <Stack>
            {allBatchStatuses.map((status: BatchTaskRunStatus) => (
              <BatchStatusCombo key={status} status={status} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Deployment statuses"
          where={["DeploymentStatus.tsx"]}
          note="Three states share the Spinner, and Queued / Canceled / Timed out all share text-text-faint with distinct glyphs."
        >
          <Stack>
            {deploymentStatuses.map((status: WorkerDeploymentStatus) => (
              <DeploymentStatus key={status} status={status} isBuilt={false} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Attempt statuses"
          where={["TaskRunAttemptStatus.tsx"]}
          note="Four of the seven are text-text-faint. A null status and ENQUEUED render identically, which is intended."
        >
          <Stack>
            <TaskRunAttemptStatusCombo status={null} />
            {allTaskRunAttemptStatuses.map((status) => (
              <TaskRunAttemptStatusCombo key={status} status={status} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Waitpoint statuses"
          where={["WaitpointStatus.tsx"]}
          note="Waiting uses raw blue-500 rather than the pending token, so it doesn't move with the preference."
        >
          <Stack>
            {WAITPOINT_STATUSES.map((status) => (
              <WaitpointStatusCombo key={status} status={status} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Bulk actions"
          where={["BulkAction.tsx"]}
          note="The type row is the interesting one: Replay is indigo-500 and Cancel is rose-500, both raw palette. The label is not tinted, so on the bulk actions list the icon tint is the only difference between a replay and a cancel at a glance."
        >
          <Stack>
            <Row>
              {BULK_ACTION_TYPES.map((type) => (
                <BulkActionTypeCombo key={type} type={type} />
              ))}
            </Row>
            {BULK_ACTION_STATUSES.map((status) => (
              <BulkActionStatusCombo key={status} status={status} />
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Enabled / disabled"
          where={["EnabledStatus.tsx", "schedules", "alerts"]}
          note="Used on schedules and alert channels. Enabled is text-success; the disabled branch sets text-dimmed, which isn't a utility in this app (the token is text-text-dimmed), so it silently inherits the row color."
        >
          <Stack>
            <EnabledStatus enabled />
            <EnabledStatus enabled={false} />
          </Stack>
        </Audit>

        <Audit
          title="Session statuses"
          where={["SessionStatus.tsx"]}
          note="Repeated here as part of the set — the Active dot is covered in section 3."
        >
          <Stack>
            {allSessionStatuses.map((status) => (
              <SessionStatusCombo key={status} status={status} pulse={false} />
            ))}
          </Stack>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="7. Charts, bars and meters"
        description="A series is identified by its swatch and nothing else. These are all judged at 3:1 against the plot surface, and separately against each other."
      >
        <Audit
          title="Stacked bars"
          where={["tailwind.css"]}
          note="Four series stacked, so the fills touch with no gap between them - the hardest case for telling two accents apart, and the one a legend can't help with once you're reading a single column. Queued moves on all four themes; Completed and Delayed only on the dark ones; Failed never moves."
        >
          <StackedBarExample />
          <SeriesLegend />
        </Audit>

        <Audit
          title="Line series"
          where={["tailwind.css"]}
          note="The same four accents as 2px strokes. A line carries a fraction of a bar's area, so an accent that reads fine as a fill can drop below the 3:1 floor here - worth checking both marks whenever a series color changes."
        >
          <LineExample />
          <SeriesLegend />
        </Audit>

        <Audit
          title="Run status series"
          where={["TaskRunStatus.tsx", "tailwind.css"]}
          note="All 17 as legend swatches, in declaration order. The three families are deliberately close-stepped so a chart stays readable — which also means adjacent pairs are near-identical in greyscale."
        >
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {RUN_STATUS_CHART_TOKENS.map((entry) => (
              <span key={entry.token} className="flex items-center gap-2">
                <span
                  className="size-3 shrink-0 rounded-xs"
                  style={{ backgroundColor: `var(${entry.token})` }}
                />
                <span className="truncate text-xs text-text-dimmed">{entry.usedBy}</span>
              </span>
            ))}
          </div>
        </Audit>

        <Audit
          title="Grouped status series"
          where={["statusColors.ts"]}
          note="The task and agent activity charts collapse everything to four series. Canceled and Expired both map to text-dimmed, so they're one swatch on the chart."
        >
          <Stack>
            {AGENT_STATUS_SERIES.map((series) => (
              <span key={series.label} className="flex items-center gap-2">
                <span
                  className="size-3 shrink-0 rounded-xs"
                  style={{ backgroundColor: `var(${series.token})` }}
                />
                <span className="text-xs text-text-dimmed">{series.label}</span>
              </span>
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Queue chart series"
          where={["tailwind.css", "queues_.$queueParam/route.tsx"]}
          note="Two series: the queue itself and a grey reference line. Under the preference the queue series moves from purple to blue; the reference greys shift per mode."
        >
          <Stack>
            <span className="flex items-center gap-2">
              <span
                className="h-1 w-10 shrink-0 rounded-full"
                style={{ backgroundColor: "var(--color-queues-chart)" }}
              />
              <span className="text-xs text-text-dimmed">This queue</span>
            </span>
            <span className="flex items-center gap-2">
              <span
                className="h-1 w-10 shrink-0 rounded-full"
                style={{ backgroundColor: "var(--color-queues-chart-ref)" }}
              />
              <span className="text-xs text-text-dimmed">Reference</span>
            </span>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-charcoal-750">
              <div className="h-full w-2/3 rounded-full bg-queues" />
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-charcoal-750">
              <div className="h-full w-11/12 rounded-full bg-warning" />
            </div>
            <Paragraph variant="extra-extra-small/caps" className="text-text-dimmed">
              concurrency meter: normal vs at limit
            </Paragraph>
          </Stack>
        </Audit>

        <Audit
          title="shadcn chart palette"
          where={["tailwind.css"]}
          note="The generic 5-series set behind the dashboard charts. chart-2 and chart-3 are darkened for the light themes and, under the real preference, for the dark ones too — that last override is keyed to <html>, so this column can't show it."
        >
          <Row>
            {CHART_SERIES.map((series) => (
              <span key={series} className="flex flex-col items-center gap-1">
                <span
                  className="size-8 rounded-xs"
                  style={{ backgroundColor: `hsl(var(${series}))` }}
                />
                <span className="font-mono text-xxs text-text-dimmed">
                  {series.replace("--", "")}
                </span>
              </span>
            ))}
          </Row>
        </Audit>

        <Audit
          title="Usage meters"
          where={["UsageBar.tsx", "FreePlanUsage.tsx", "settings.usage/route.tsx"]}
          note="The billing bar stacks three raw greens (green-600, green-700, green-900/20) whose only difference is depth. The free-plan meter interpolates success → warning → error as it fills, so the fill level and the color say the same thing twice — but the color is the part that's read."
        >
          <Stack className="w-full gap-3">
            <div className="w-full space-y-1">
              <Paragraph variant="extra-extra-small/caps" className="text-text-dimmed">
                UsageBar — used (green-600) over included usage (green-900/20)
              </Paragraph>
              <div className="relative h-3 w-full rounded-sm bg-background-raised">
                <div className="absolute h-3 w-3/4 rounded-l-sm bg-green-900/20" />
                <div className="absolute h-3 w-1/2 rounded-l-sm bg-green-600" />
              </div>
            </div>
            <div className="w-full space-y-1">
              <Paragraph variant="extra-extra-small/caps" className="text-text-dimmed">
                UsageBar — over the tier limit (green-700)
              </Paragraph>
              <div className="relative h-3 w-full rounded-sm bg-background-raised">
                <div className="absolute h-3 w-11/12 rounded-l-sm bg-green-700" />
              </div>
            </div>
            <div className="w-full space-y-1.5">
              <Paragraph variant="extra-extra-small/caps" className="text-text-dimmed">
                FreePlanUsage — 33% / 80% / 100%
              </Paragraph>
              {(
                [
                  { width: "w-1/3", className: "bg-success" },
                  { width: "w-4/5", className: "bg-warning" },
                  { width: "w-full", className: "bg-error" },
                ] as const
              ).map((meter) => (
                <div key={meter.width} className="h-1 w-full rounded-full bg-background-dimmed">
                  <div className={cn("h-1 rounded-full", meter.width, meter.className)} />
                </div>
              ))}
            </div>
          </Stack>
        </Audit>

        <Audit
          title="Report sparkline tones"
          where={["report-sparkline.tsx"]}
          note="ok / warn / crit map straight onto success / warning / error, with no marker shape or threshold line to fall back on."
        >
          <Row>
            {(
              [
                { tone: "ok", className: "text-success" },
                { tone: "warn", className: "text-warning" },
                { tone: "crit", className: "text-error" },
              ] as const
            ).map((item) => (
              <span key={item.tone} className={cn("flex items-center gap-1.5", item.className)}>
                <svg viewBox="0 0 48 16" className="h-4 w-12">
                  <polyline
                    points="0,12 8,10 16,13 24,6 32,8 40,3 48,5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
                <span className="font-mono text-xs">{item.tone}</span>
              </span>
            ))}
          </Row>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="8. Trace and timeline"
        description="In the waterfall and the run timeline the bar itself is the status. There is no icon, no label and no pattern — apart from the animated tile on in-progress spans."
      >
        <Audit
          title="Trace waterfall bars"
          where={["SpanTitle.tsx", "runs.$runParam/route.tsx"]}
          note="eventBackgroundClassName resolves a span to one of these fills. In-progress spans also get a scrolling tile overlay, which is the only non-color cue in the set."
        >
          <Stack className="w-full">
            {TRACE_BAR_STATES.map((state) => (
              <div key={state.label} className="flex w-full items-center gap-2">
                <span className={cn("h-4 w-24 shrink-0 rounded-sm", state.className)} />
                <span className="truncate text-xs text-text-dimmed">{state.label}</span>
              </div>
            ))}
          </Stack>
        </Audit>

        <Audit
          title="Span titles"
          where={["SpanTitle.tsx"]}
          note="Primary spans are blue-500 and go monochrome under the preference; WARN titles are amber-400 and ERROR titles are text-error, and neither does. Wait spans are sky-500 in both the icon and the title."
        >
          <Stack>
            <span className="font-mono text-sm text-blue-500 system:text-text-bright">
              my-task.run()
            </span>
            <span className="font-mono text-sm text-text-dimmed">prisma:query</span>
            <span className="font-mono text-sm text-amber-400">Retrying in 2s</span>
            <span className="font-mono text-sm text-error">Error: fetch failed</span>
            <span className="font-mono text-sm text-sky-500">wait.for({"{ seconds: 5 }"})</span>
          </Stack>
        </Audit>

        <Audit
          title="Run timeline events"
          where={["RunTimeline.tsx"]}
          note="Markers and connecting lines share one state → color map (complete / error / inprogress / delayed). The delayed and neutral states are the same text-dimmed, and the fallback marker variant is a hard-coded yellow-500 dot."
        >
          <div className="min-w-fit">
            <RunTimelineEvent title="Triggered" state="complete" variant="start-cap" />
            <RunTimelineLine title="Waiting to dequeue" state="complete" variant="light" />
            <RunTimelineEvent title="Dequeued" state="complete" />
            <RunTimelineLine title="Executing" state="inprogress" />
            <RunTimelineEvent title="Started" state="inprogress" />
            <RunTimelineLine title="Delayed" state="delayed" variant="light" />
            <RunTimelineEvent title="Failed" state="error" variant="end-cap" />
          </div>
        </Audit>

        <Audit
          title="Timeline duration labels"
          where={["runs.$runParam/route.tsx", "tailwind.css"]}
          note="The duration sits on top of the bar in text-text-bright with a text-shadow for legibility. Under the preference the shadow is dropped, so the label's contrast then depends entirely on the bar's fill."
        >
          <Stack className="w-full">
            {[
              { label: "1.2s", className: "bg-success" },
              { label: "840ms", className: "bg-error" },
              { label: "12s", className: "bg-blue-500" },
            ].map((bar) => (
              <div
                key={bar.label}
                className={cn(
                  "flex h-4 w-32 items-center rounded-sm px-1",
                  "timeline-span",
                  bar.className
                )}
              >
                <span className="text-xxs text-text-bright text-shadow-custom">{bar.label}</span>
              </div>
            ))}
          </Stack>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="9. Navigation accents"
        description="Each nav section has its own accent, applied to the icon when the item is active. Under the preference the active icon goes monochrome — which is the right call for contrast, and also removes the only thing distinguishing two sections that share a glyph family."
      >
        <Audit
          title="Active nav item"
          where={["SideMenu.tsx", "sideMenuSections.tsx", "tailwind.css"]}
          note="side-menu-active-icon is the marker class the preference keys off; the accent arrives as a utility class, exactly as SideMenuItem applies it. Inactive items are text-dimmed in both treatments. The first row is the active one."
        >
          <Stack className="w-full">
            {NAV_ITEMS.map((item, index) => {
              const Icon = item.icon;
              const isActive = index === 0;
              return (
                <span
                  key={item.label}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-sm",
                    isActive ? "bg-tertiary text-text-bright" : "text-text-dimmed"
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4.5",
                      isActive
                        ? cn(item.activeIconColor, "side-menu-active-icon")
                        : "text-text-dimmed"
                    )}
                  />
                  {item.label}
                </span>
              );
            })}
          </Stack>
        </Audit>

        <Audit
          title="The same items, all active"
          where={["SideMenuItem.tsx"]}
          note="Only one nav item is ever active at a time, so the accents are never compared in place. Forced on together here — and note what the preference does to all five at once."
        >
          <Stack className="w-full">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <span
                  key={item.label}
                  className="flex w-full items-center gap-2 rounded-sm bg-tertiary px-2 py-1 text-sm text-text-bright"
                >
                  <Icon className={cn("size-4.5", item.activeIconColor, "side-menu-active-icon")} />
                  {item.label}
                </span>
              );
            })}
          </Stack>
        </Audit>

        <Audit
          title="Every nav accent, side by side"
          where={["tailwind.css"]}
          note="Squares rather than icons, so the accents can be compared without the glyph shapes helping. Same-hue clusters are what to look for."
        >
          <div className="flex flex-wrap gap-1">
            {ACCENT_TOKENS.map((entry) => (
              <span
                key={entry.token}
                title={entry.token}
                className="size-5 rounded-xs border border-grid-bright"
                style={{ backgroundColor: `var(${entry.token})` }}
              />
            ))}
          </div>
        </Audit>
      </StorySection>

      {/* ------------------------------------------------------------------ */}
      <StorySection
        title="10. Colored text on its own"
        description="Text where the color is doing semantic work with no icon beside it. Most of these carry the meaning in the words too, which is why they're listed last — but they're all in the contrast audit."
      >
        <Audit
          title="Inline state words"
          where={["queues/route.tsx", "concurrency/route.tsx", "limits/route.tsx"]}
          note="The queues and concurrency pages append bare colored words and numbers to otherwise neutral rows."
        >
          <Stack>
            <span className="text-sm text-text-bright">
              Concurrency <span className="text-text-dimmed">12 / 20</span>{" "}
              <span className="text-warning">paused</span>
            </span>
            <span className="text-sm tabular-nums text-warning">18 / 20</span>
            <span className="text-sm tabular-nums text-error">20 / 20</span>
            <span className="flex items-center gap-1 text-sm text-error">
              <ExclamationTriangleIcon className="size-4" />
              Over-allocated by 4
            </span>
            <span className="flex items-center gap-1 text-sm text-success">
              <InformationCircleIcon className="size-4" />8 available to allocate
            </span>
          </Stack>
        </Audit>

        <Audit
          title="Form validation and hints"
          where={["Hint.tsx", "SettingsLayout.tsx", "FormError.tsx"]}
          note="Field errors are text-error with no icon; danger sections in settings switch a heading between text-error and text-warning."
        >
          <Stack>
            <span className="text-xs text-error" role="alert">
              Enter a valid cron expression
            </span>
            <Paragraph variant="small" className="text-warning">
              Changing this will re-index every deployed task.
            </Paragraph>
            <span className="text-sm text-text-bright">
              Admin name <span className="text-error">*</span>
            </span>
          </Stack>
        </Audit>

        <Audit
          title="Copy confirmation"
          where={["CopyButton.tsx", "CopyableText.tsx", "Table.tsx", "CodeBlock.tsx"]}
          note="The glyph swaps from clipboard to check as well as going green, so the state survives greyscale — but the greens are raw palette (green-500) in three of the four call sites and the semantic token in the fourth."
        >
          <Row>
            <span className="flex items-center gap-1 text-sm text-green-500">
              <CheckCircleIcon className="size-4" />
              Copied (green-500)
            </span>
            <span className="flex items-center gap-1 text-sm text-success">
              <CheckCircleIcon className="size-4" />
              Copied (success)
            </span>
          </Row>
        </Audit>

        <Audit
          title="Diffs and change previews"
          where={["admin.feature-flags.tsx", "QueryEditor.tsx"]}
          note="Added and removed lines are green-400 and red-400 with a +/- prefix. Admin-only, and the prefix carries the meaning — but the raw palette values don't move for the light themes."
        >
          <Stack>
            <span className="font-mono text-xs text-green-400">+ maxConcurrency: 40</span>
            <span className="font-mono text-xs text-red-400">- maxConcurrency: 20</span>
          </Stack>
        </Audit>

        <Audit
          title="Icon-only affordances"
          where={["TaskRunsTable.tsx", "TitleWidget.tsx", "WatchChips.tsx"]}
          note="Row actions tint their leading icon to signal intent: text-error for cancel and delete, text-success for replay. The menu label says which, but the icon color is what's scanned."
        >
          <Stack>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <XCircleIcon className="size-4 text-error" />
              Cancel run
            </span>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <NoSymbolIcon className="size-4 text-error" />
              Delete dashboard
            </span>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <RectangleStackIcon className="size-4 text-success" />
              Replay run
            </span>
            <span className="flex items-center gap-2 text-sm text-text-bright">
              <Spinner className="size-4" />
              Working…
            </span>
          </Stack>
        </Audit>
      </StorySection>
    </StoryPage>
  );
}

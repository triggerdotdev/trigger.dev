// The run page's parts, shared by the run-* figures: the header and toolbar, the trace tree with
// its timeline, the inspector (the run's tabs or a span's details) and what goes in it. Drawn from
// the run route and the storybook run pages; the webapp files they mirror are the figures'
// `sources` in lib/dashboard-figures.ts.
import type { ReactNode } from "react";
import { Button, SmallSwitch } from "./chrome";
import * as I from "./icons";

// ---- Header and toolbar (the run route's NavBar, runs/v3/trace/TraceToolbar.tsx) ----

export function RunHeader({ runId }: { runId: string }) {
  return (
    <div className="grid h-10 w-full grid-rows-[auto_1px] bg-background-bright">
      <div className="flex w-full items-center gap-2 pl-3 pr-2">
        <div className="flex flex-1 items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="group -ml-1.5 flex items-center gap-0">
              <span className="rounded px-1.5 py-1 text-xs text-text-dimmed">Runs</span>
              <I.BreadcrumbIcon className="text-border-bright h-5" />
            </div>
            <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright flex items-center gap-1">
              <div className="flex items-center gap-x-0">
                <div className="flex w-fit font-normal justify-center items-center shrink-0 rounded-[3px] bg-transparent py-0 text-left text-text-dimmed -ml-1.75 h-6 px-1.5 font-mono text-xs">
                  <div className="relative flex w-full items-center">
                    <div className="justify-center flex w-full items-center text-text-dimmed gap-x-2.5">
                      <span>{runId}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <span className="flex -ml-1">
              <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] text-xs bg-transparent aspect-square h-6 p-1">
                <I.StarIcon className="size-4 text-text-dimmed" />
              </div>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* The Ask Trigger launcher replaces this when the dashboard agent is on. */}
            <Button variant="docs" icon={I.BookIcon}>
              Run docs
            </Button>
          </div>
        </div>
      </div>
      <div className="relative h-px w-full bg-grid-bright" />
    </div>
  );
}

export function RunToolbar() {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-bright pl-1.5 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className="relative h-6 min-w-52">
          <div className="flex items-center px-1 h-6 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full">
            <div className="flex items-center">
              <I.SearchIcon className="size-4 text-text-bright" />
            </div>
            <div className="flex items-center grow h-full w-full text-text-dimmed bg-transparent px-1 rounded text-xs">
              Search logs…
            </div>
          </div>
        </div>
        <SmallSwitch label="Queue time" />
        <SmallSwitch label="Errors only" />
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <div className="flex items-center gap-2">
          <Button
            icon={I.ArrowUturnLeftIcon}
            shortcut="r"
            className="pr-2"
            mark="replay"
            markBadge="below"
          >
            Replay run
          </Button>
        </div>
      </div>
    </div>
  );
}

/** primitives/Resizable.tsx: the handle between two panels. */
export function ResizeHandle() {
  return (
    <div
      className="group relative flex items-center justify-center w-0.75 shrink-0 before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright"
      style={{ height: "100%" }}
    >
      <div className="relative z-1 flex h-5 w-0.75 flex-col items-center justify-center gap-0.75 bg-background-dimmed">
        <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
        <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
        <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
      </div>
    </div>
  );
}

// ---- Trace tree and timeline (runs/v3/trace/TasksTreeView.tsx, TimelineView.tsx) ----

type SpanKind =
  | "task"
  | "attempt"
  | "function"
  | "log"
  | "warn"
  | "error"
  | "wait"
  | "trigger"
  | "span"
  | "prisma";

/** runs/v3/RunIcon.tsx and SpanTitle.tsx: each kind's icon, icon colour and text colour. */
const kinds: Record<
  SpanKind,
  { icon: (p: { className?: string }) => ReactNode; color: string; text: string }
> = {
  task: { icon: I.TaskIcon, color: "text-tasks", text: "text-blue-500" },
  attempt: { icon: I.AttemptIcon, color: "text-text-dimmed", text: "text-text-dimmed" },
  function: { icon: I.RunFunctionIcon, color: "text-text-dimmed", text: "text-text-dimmed" },
  log: { icon: I.InfoIcon, color: "text-text-dimmed", text: "text-text-dimmed" },
  warn: { icon: I.InfoIcon, color: "text-amber-400", text: "text-amber-400" },
  error: { icon: I.InfoIcon, color: "text-error", text: "text-error" },
  wait: { icon: I.PauseIcon, color: "text-sky-500", text: "text-sky-500" },
  trigger: { icon: I.TriggerIcon, color: "text-orange-500", text: "text-text-dimmed" },
  span: { icon: I.Squares2X2OutlineIcon, color: "text-text-dimmed", text: "text-text-dimmed" },
  // A span named prisma:*; TablerIcon sets no colour, so the icon takes the row's.
  prisma: { icon: I.TablerBrandPrismaIcon, color: "text-text-dimmed", text: "text-text-dimmed" },
};

function RunIcon({ kind, className }: { kind: SpanKind; className: string }) {
  const k = kinds[kind];
  return <k.icon className={`${className} ${k.color}`} />;
}

export type TraceRow = {
  kind: SpanKind;
  label: string;
  /** The span's accessory, e.g. a wait's "5 seconds". */
  badge?: string;
  depth: number;
  /** Has children, drawn expanded. */
  open?: boolean;
  /** Has children, drawn collapsed. */
  closed?: boolean;
  root?: boolean;
  /** The root's tick, or the attempt's cold start snowflake. */
  status?: "completed" | "cold";
  selected?: boolean;
  /** ms from the start of the run. */
  start: number;
  /** A span's duration in ms; a log has none and is a point. */
  duration?: number;
  /** An attempt's timeline events (ms): a line, then dots, joined up to the span. */
  events?: number[];
};

function SpanText({ kind, label, badge }: { kind: SpanKind; label: string; badge?: string }) {
  return (
    <span className={`flex items-center gap-x-2 overflow-x-hidden ${kinds[kind].text}`}>
      <span className="truncate">{label}</span>{" "}
      {badge && (
        <span className="inline-flex items-center gap-0.5 truncate rounded border border-grid-bright bg-background-bright px-1.5 py-0.5 font-mono text-text-dimmed overflow-x-hidden text-xs">
          <span className="truncate text-text-dimmed">{badge}</span>
        </span>
      )}
    </span>
  );
}

function TreeRow({ row }: { row: TraceRow }) {
  return (
    <div className="overflow-clip">
      <div
        className={`group/spannode flex h-8 items-center overflow-hidden rounded-l-sm pr-2 ${row.selected ? "bg-grid-dimmed" : "bg-transparent"}`}
      >
        <div className="flex h-8 items-center">
          {Array.from({ length: row.depth }, (_, i) => (
            <div key={i} className="h-8 w-2 border-r border-grid-bright" />
          ))}
          <div className="flex h-8 w-4 items-center">
            {row.open ? (
              <I.ChevronDownIcon className="h-4 w-4 text-text-dimmed" />
            ) : row.closed ? (
              <I.ChevronRightIcon className="h-4 w-4 text-text-dimmed" />
            ) : (
              <div className="h-8 w-4" />
            )}
          </div>
        </div>
        <div className="flex w-full items-center justify-between gap-2 pl-1">
          <div className="flex items-center gap-1.5 overflow-x-hidden">
            <RunIcon kind={row.kind} className="size-5 min-h-5 min-w-5" />
            <div className="font-sans text-sm font-medium text-text-dimmed truncate">
              <SpanText kind={row.kind} label={row.label} badge={row.badge} />
            </div>
            {row.root && (
              <div className="grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright text-blue-500 whitespace-nowrap">
                <span>Root</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {row.status === "completed" && <I.CheckCircleIcon className="text-success size-4" />}
            {row.status === "cold" && (
              <div className="h-fit">
                <I.WarmStartIcon className="text-blue-400 size-4" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** formatDurationMilliseconds, style "short", as the timeline labels it. */
function shortDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${+s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function TimelineRow({ row, at }: { row: TraceRow; at: (ms: number) => string }) {
  const variant = row.kind === "task" ? "bg-success" : "bg-surface-control-active";
  const point = row.kind === "warn" ? "bg-amber-400" : row.kind === "error" ? "bg-error" : variant;
  const events = row.events ?? [];
  return (
    <div
      className={`group flex h-8 items-center ${row.selected ? "bg-grid-dimmed" : "bg-transparent"}`}
      style={{ position: "relative" }}
    >
      {row.duration === undefined ? (
        <div style={{ position: "absolute", left: at(row.start) }}>
          <div
            className={`timeline-point -ml-0.5 size-3 rounded-full border-2 border-background-bright ${point}`}
          />
        </div>
      ) : (
        <>
          {events.map((ms, i) =>
            i === 0 ? (
              <div key={i} style={{ position: "absolute", left: at(ms) }}>
                <div className={`ml-[-0.5px] h-2.25 w-px rounded-none ${variant}`} />
              </div>
            ) : (
              <div key={i} className="z-10" style={{ position: "absolute", left: at(ms) }}>
                <div
                  className={`ml-[-0.1562rem] size-1.25 rounded-full border bg-background-bright ${row.kind === "task" ? "border-success" : "border-border-brightest"}`}
                />
              </div>
            )
          )}
          {events.length > 0 && (
            <div
              style={{
                position: "absolute",
                left: at(events[0]),
                width: `calc(${at(row.start)} - ${at(events[0])})`,
              }}
            >
              <div className={`h-px w-full ${variant}`} />
            </div>
          )}
          <div
            style={{
              position: "absolute",
              left: at(row.start),
              width: `calc(${at(row.start + row.duration)} - ${at(row.start)})`,
            }}
          >
            {/* The root span fades in from the left when the queue time is hidden. */}
            <div
              className={`timeline-span relative flex h-4 w-full min-w-0.5 items-center ${variant} ${row.root ? "rounded-r-sm bg-linear-to-r from-black/50 to-transparent" : "rounded-sm"}`}
              style={{ backgroundSize: "20px 100%", backgroundRepeat: "no-repeat" }}
            >
              <div className="sticky left-0 z-10">
                <div className="whitespace-nowrap rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom">
                  {shortDuration(row.duration)}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The tree, its timeline and the footer under them; `total` is the run's duration in ms. */
export function TraceView({
  rows,
  total,
  header = "This is the root task",
  footer = true,
}: {
  rows: TraceRow[];
  total: number;
  header?: string;
  /** false crops off the shortcuts and zoom bar under the trace. */
  footer?: boolean;
}) {
  // timelineDurationMs: the axis runs 5% past the end; 5 equal ticks, the last unlabelled.
  const span = total * 1.05;
  const at = (ms: number) => `${(ms / span) * 100}%`;
  const ticks = [0, 1, 2, 3, 4].map((i) => (span / 4) * i);
  return (
    <div
      className={`grid h-full overflow-hidden ${footer ? "grid-rows-[1fr_3.25rem]" : "grid-rows-[1fr]"}`}
    >
      <div className="flex w-full overflow-hidden h-full">
        <div className="min-w-0 flex-1">
          <div className="grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            <div className="flex items-center justify-between pl-1 pr-2">
              <div className="font-sans text-xs font-medium flex-1 pl-3 text-text-faint">
                {header}
              </div>
            </div>
            <div className="w-full overflow-y-auto pl-3">
              {rows.map((row, i) => (
                <TreeRow key={i} row={row} />
              ))}
            </div>
          </div>
        </div>
        <ResizeHandle />
        <div className="min-w-0 flex-1">
          <div className="h-full overflow-x-auto overflow-y-hidden">
            <div className="h-full overflow-hidden w-full" style={{ position: "relative" }}>
              <div className="grid h-full grid-rows-[2rem_1fr]" style={{ position: "relative" }}>
                <div style={{ position: "relative" }}>
                  <div className="h-6" style={{ position: "relative" }}>
                    {ticks.slice(0, 4).map((ms, i) => (
                      <div
                        key={i}
                        className="relative bottom-[2px] text-xxs text-text-dimmed"
                        style={{ position: "absolute", left: at(ms) }}
                      >
                        <div
                          className={`whitespace-nowrap ${i === 0 ? "ml-1" : "-translate-x-1/2"}`}
                        >
                          {shortDuration(ms)}
                        </div>
                      </div>
                    ))}
                    <div
                      className="relative bottom-[2px] text-xxs text-success"
                      style={{ position: "absolute", left: at(total) }}
                    >
                      <div className="-translate-x-1/2 whitespace-nowrap">
                        {shortDuration(total)}
                      </div>
                    </div>
                  </div>
                  <div className="h-2" style={{ position: "relative" }}>
                    {ticks.slice(1, 4).map((ms, i) => (
                      <div
                        key={i}
                        className="h-full border-r border-grid-dimmed"
                        style={{ position: "absolute", left: at(ms) }}
                      />
                    ))}
                    <div
                      className="h-full border-r border-success/30"
                      style={{ position: "absolute", left: at(total) }}
                    />
                  </div>
                </div>
                <div className="overflow-hidden" style={{ position: "relative" }}>
                  {ticks.slice(1).map((ms, i) => (
                    <div
                      key={i}
                      className="h-full border-r border-grid-dimmed"
                      style={{ position: "absolute", left: at(ms) }}
                    />
                  ))}
                  <div
                    className="h-full border-r border-success/30"
                    style={{ position: "absolute", left: at(total) }}
                  />
                  <div className="w-full overflow-y-auto h-full scrollbar-hide">
                    {rows.map((row, i) => (
                      <TimelineRow key={i} row={row} at={at} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Under 48rem wide the shortcuts fold into a "Shortcuts" popover. */}
      {footer && (
        <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-4">
          <div className="grow">
            <div className="group flex h-6 items-center gap-1 rounded pl-2 pr-1 text-text-dimmed">
              <div className="font-sans text-xs font-medium text-text-dimmed flex">Shortcuts</div>
              <span className="contents">
                <I.DropdownIcon className="size-4 min-w-4 text-text-dimmed" />
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="group flex items-center h-6 gap-1 rounded-sm px-1">
              <I.MagnifyingGlassMinusIcon className="h-4 w-4 text-text-bright" />
              <span className="relative flex items-center h-4 w-20">
                <span className="relative grow rounded-full h-1 bg-grid-bright">
                  <span className="absolute h-full rounded-full bg-transparent" />
                </span>
                <span>
                  <span className="relative block rounded-full h-3 w-3 border-2 border-text-dimmed bg-grid-bright" />
                </span>
              </span>
              <I.MagnifyingGlassPlusIcon className="h-4 w-4 text-text-bright" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Inspector (the run route's RunBody and SpanBody) ----

function EscButton() {
  return (
    <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-transparent pl-1">
      <div className="relative flex w-full items-center">
        <div className="justify-center flex w-full items-center text-text-dimmed gap-x-2.5">
          <span className="justify-center text-[0.6rem] font-mono font-medium min-w-4 min-h-4 rounded-[2px] tabular-nums px-1 flex items-center gap-x-1 border uppercase -ml-0.5 -mr-1.5 justify-self-center border-dimmed/40 text-text-dimmed">
            <span>
              <span className="capitalize">Esc</span>
            </span>
          </span>
          <I.ExitIcon className="h-3.5 -mx-1 text-text-dimmed shrink-0 justify-end" />
        </div>
      </div>
    </div>
  );
}

const tabs = [
  ["Overview", "o"],
  ["Detail", "d"],
  ["Context", "x"],
  ["Metadata", "m"],
] as const;

type RunTab = (typeof tabs)[number][0];

/** The inspector for a run (a task span): its tabs, then `children` for the open tab. */
export function RunInspector({
  task,
  tab,
  tabMark,
  children,
}: {
  task: string;
  tab: RunTab;
  /** data-mark for the open tab. */
  tabMark?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr_minmax(3.25rem,auto)] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3 pr-2">
        <div className="flex items-center gap-1 overflow-x-hidden">
          <I.TaskIcon className="size-5 min-h-5 min-w-5 text-tasks" />
          <div className="font-sans text-base leading-6 font-semibold tracking-tight overflow-x-hidden text-tasks light:text-text-bright">
            <span className="truncate">{task}</span>
          </div>
        </div>
        <EscButton />
      </div>
      <div className="h-fit px-3">
        <div className="flex gap-x-6 border-b border-grid-bright">
          {tabs.map(([name, key]) => (
            <div
              key={name}
              className="group/tab flex flex-col items-center pt-1"
              data-mark={name === tab ? tabMark : undefined}
              data-mark-badge={name === tab && tabMark ? "below" : undefined}
            >
              <div className="flex items-center gap-1">
                <span className="text-sm text-text-bright">{name}</span>
                <span className="justify-center text-[0.6rem] font-mono font-medium min-w-4 min-h-4 rounded-[2px] tabular-nums px-1 ml-1 -mr-0.5 flex items-center gap-x-1 border uppercase border-text-dimmed/40 text-text-dimmed">
                  <span>{key}</span>
                </span>
              </div>
              <div
                className={
                  name === tab
                    ? "h-0.5 w-full bg-indigo-500 mt-1"
                    : "h-0.5 w-full bg-surface-control-active opacity-0 mt-1"
                }
              />
            </div>
          ))}
        </div>
      </div>
      <div className="overflow-y-auto px-3">{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-grid-dimmed px-2 py-2">
        <div className="flex items-center gap-4" />
        <div className="flex items-center">
          <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-8 px-3 text-sm bg-secondary border border-border-bright/50 shadow-xs">
            <div className="relative flex w-full items-center">
              <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
                <I.CloudArrowDownIcon className="h-4 -mx-1 text-indigo-400 shrink-0 justify-start" />
                <span className="mx-auto grow self-center truncate">Export trace</span>
                <I.ChevronUpIcon className="h-4 -mx-1 text-text-bright shrink-0 justify-end" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The inspector for a span or a log: no tabs, the title in the span's colours. */
export function SpanInspector({
  kind,
  title,
  children,
}: {
  kind: SpanKind;
  title: string;
  children: ReactNode;
}) {
  const text = kinds[kind].text === "text-text-dimmed" ? "text-text-bright" : kinds[kind].text;
  return (
    <div className="grid h-full max-h-full overflow-hidden bg-background-bright grid-rows-[2.5rem_1fr]">
      <div className="border-b border-grid-bright px-3 pr-2">
        <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <RunIcon kind={kind} className="size-5 min-h-5 min-w-5" />
            <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright min-w-0">
              <span className={`flex items-center gap-x-2 overflow-x-hidden ${text}`}>
                <span className="truncate">{title}</span>{" "}
              </span>
            </div>
          </div>
          <EscButton />
        </div>
      </div>
      <div className="overflow-y-auto">
        <div className="flex flex-col gap-4 p-3">{children}</div>
      </div>
    </div>
  );
}

export function CompletedStatus() {
  return (
    <div className="border-b border-grid-bright pb-3">
      <div className="h-fit">
        <span className="flex items-center gap-1 text-sm">
          <I.CheckCircleIcon className="text-success h-4 w-4" />
          <span className="text-success">Completed</span>
        </span>
      </div>
    </div>
  );
}

// ---- RunTimeline (runs/v3/RunTimeline.tsx) ----

type TimelineItem =
  | {
      event: string;
      date: string;
      marker: "start-cap" | "dot-hollow" | "dot-solid" | "start-cap-thick" | "end-cap-thick";
    }
  | { line: string; thick?: boolean };

/** A run's events and the gaps between them; `done` colours them success, else dimmed. */
export function RunTimeline({ items, done }: { items: TimelineItem[]; done?: boolean }) {
  const bg = done ? "bg-success" : "bg-text-dimmed";
  const border = done ? "border-success" : "border-text-dimmed";
  const markers = {
    "start-cap": (
      <>
        <div className={`h-full w-1.75 border-b ${border}`} />
        <div className={`relative h-full w-px ${bg}`} />
      </>
    ),
    "dot-hollow": (
      <>
        <div className={`relative h-full w-px ${bg}`} />
        <div className={`size-1.25 min-h-1.25 rounded-full border ${border}`} />
        <div className={`relative h-full w-px ${bg}`} />
      </>
    ),
    "dot-solid": <div className={`size-1.25 rounded-full ${bg}`} />,
    "start-cap-thick": <div className={`relative h-full w-1.75 rounded-t-xs ${bg}`} />,
    "end-cap-thick": <div className={`h-full w-1.75 rounded-b-xs ${bg}`} />,
  };
  return (
    <div className="min-w-fit max-w-80">
      {items.map((item, i) =>
        "event" in item ? (
          <div key={i} className="grid h-5 grid-cols-[1.125rem_1fr] gap-1 text-sm">
            <div className="relative flex flex-col items-center justify-center">
              {markers[item.marker]}
            </div>
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <div className="min-w-0 max-w-full text-left">
                <div className="truncate font-medium text-text-bright">{item.event}</div>
              </div>
              <span className="whitespace-nowrap text-xs tabular-nums text-text-dimmed">
                <span>{item.date}</span>
              </span>
            </div>
          </div>
        ) : (
          <div key={i} className="grid grid-cols-[1.125rem_1fr] gap-1 text-xs h-6">
            <div className="flex items-stretch justify-center">
              <div className={`relative ${item.thick ? "w-1.75" : "w-px"} ${bg}`} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-dimmed">{item.line}</span>
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ---- Code blocks (code/CodeBlock.tsx, JSON through prism) ----

const tokenColors: Record<string, string> = {
  punctuation: "var(--color-code-foreground)",
  property: "var(--color-code-language)",
  operator: "var(--color-code-plain)",
  string: "var(--color-code-string)",
  number: "var(--color-code-builtin)",
  boolean: "var(--color-code-builtin)",
};

/** prism's JSON tokens for one line of `JSON.stringify(value, null, 2)`. */
function tokens(line: string) {
  const out: [string, string | undefined][] = [];
  const re =
    /("(?:[^"\\]|\\.)*")(:)?|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|(true|false)|([{}[\],])|(:)|(\s+)/g;
  for (const m of line.matchAll(re)) {
    if (m[1] && m[2]) {
      out.push([m[1], "property"], [":", "operator"]);
    } else if (m[1]) out.push([m[1], "string"]);
    else if (m[3]) out.push([m[3], "number"]);
    else if (m[4]) out.push([m[4], "boolean"]);
    else if (m[5]) out.push([m[5], "punctuation"]);
    else if (m[6]) out.push([m[6], "operator"]);
    else out.push([m[0], undefined]);
  }
  return out;
}

/** A packet (payload, output, properties) as the dashboard prints it. */
export function CodeBlock({ title, value }: { title?: string; value: unknown }) {
  const lines = JSON.stringify(value, null, 2).split("\n");
  return (
    <div className="relative flex flex-col overflow-hidden rounded-md border border-grid-bright">
      {title && (
        <div className="flex items-center justify-between px-3">
          <div className="font-sans text-sm font-medium text-text-bright w-full border-b border-grid-dimmed py-2">
            {title}
          </div>
        </div>
      )}
      <div className={`absolute right-3 z-50 flex gap-3 ${title ? "top-2.5" : "top-3"}`}>
        <div>
          <I.TextWrapIcon className="size-4" />
        </div>
        <div className="text-text-dimmed">
          <I.ClipboardIcon className="size-4" />
        </div>
        <div>
          <I.ArrowsPointingOutIcon className="size-4" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-3">
        <div
          className="relative mr-2 font-mono text-xs whitespace-pre"
          style={{ color: "var(--color-code-constant)" }}
        >
          {lines.map((line, i) => (
            <div key={i} className="flex w-full justify-start">
              <div className="flex-1">
                {tokens(line).map(([text, type], j) => (
                  <span key={j} style={type ? { color: tokenColors[type] } : undefined}>
                    {text}
                  </span>
                ))}
              </div>
              <div className="w-4 flex-none" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- Properties (primitives/PropertyTable.tsx) ----

/** A span's or log's Message, in a property table, with its Copy link (primitives/CopyTextLink.tsx). */
export function MessageProperty({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-y-3">
      <div className="flex flex-col gap-0 text-sm">
        <div className="font-medium text-text-bright flex items-center justify-between">
          <span>Message</span>
          <span className="inline-flex items-center gap-1 text-xs text-text-dimmed">
            Copy
            <I.ClipboardIcon className="size-3" />
          </span>
        </div>
        <div className="text-text-dimmed whitespace-pre-wrap wrap-break-word">{message}</div>
      </div>
    </div>
  );
}

export function Property({
  label,
  children,
  mark,
}: {
  label: ReactNode;
  children: ReactNode;
  mark?: string;
}) {
  return (
    <div className="flex flex-col gap-0 text-sm" data-mark={mark}>
      <div className="font-medium text-text-bright">{label}</div>
      <div className="text-text-dimmed">{children}</div>
    </div>
  );
}

/** A value that links somewhere (the task, the version). */
export function LinkValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-text-link text-text-link inline-flex gap-0.5 items-center group">
      <span className="group relative inline-flex h-6 items-center">
        <span>{children}</span>
      </span>
    </span>
  );
}

/** runs/v3/RunTag.tsx: a tag, its prefix and value apart when splitTag finds one. `linked` is
 * the inspector's version (a link to the runs filtered by the tag); the runs table's isn't. */
export function RunTagView({ tag, linked }: { tag: string; linked?: boolean }) {
  // shortcut: splitTag's rule without its ID-format exceptions, fine for the example tags.
  const m = tag.match(/^([a-zA-Z0-9]{1,12})[_:](.*)$/);
  const content = (
    <>
      <I.TagLeftIcon className="block h-full w-2.25" />
      {m ? (
        <>
          <span className="flex items-center border-y border-r border-grid-bright bg-background-bright pr-1.5 text-text-dimmed">
            {m[1]}
          </span>
          <span className="flex items-center whitespace-nowrap rounded-r-sm border-y border-r border-grid-bright bg-background-hover px-1.5 text-text-dimmed">
            {m[2]}
          </span>
        </>
      ) : (
        <span className="flex items-center rounded-r-sm border-y border-r border-grid-bright bg-background-bright pr-1.5 text-text-dimmed">
          {tag}
        </span>
      )}
    </>
  );
  return (
    <div className="group relative inline-flex shrink-0">
      {linked ? (
        <span className="group shrink-0">
          <span className="flex h-6 items-stretch">{content}</span>
        </span>
      ) : (
        <span className="flex h-6 shrink-0 items-stretch">{content}</span>
      )}
    </div>
  );
}

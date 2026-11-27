// The Query page before a query has run, without the side menu: the TRQL editor with its default
// query, the editor toolbar, the empty results panel and the AI help panel. Copied from the rendered
// dashboard (capture.js) at a 1000px page width; panel sizes and editor colors measured there. The
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import type { ReactNode } from "react";
import { Button, PageHeader } from "./chrome";
import * as I from "./icons";

// The default query, as the TRQL highlighter colors it.
const kw = (t: string) => <span className="text-editor-keyword">{t}</span>;
const nm = (t: string) => <span className="text-editor-name">{t}</span>;
const lines: ReactNode[] = [
  kw("SELECT"),
  <>
    {"  "}
    {nm("run_id")},
  </>,
  <>
    {"  "}
    {nm("task_identifier")},
  </>,
  <>
    {"  "}
    {nm("triggered_at")},
  </>,
  <>
    {"  "}
    {nm("status")}
  </>,
  kw("FROM"),
  <>
    {"  "}
    {nm("runs")}
  </>,
  <>
    {kw("ORDER")} {kw("BY")}
  </>,
  <>
    {"  "}
    {nm("triggered_at")} {kw("DESC")}
  </>,
  kw("LIMIT"),
  <>
    {"  "}
    <span className="text-editor-type">100</span>
  </>,
];

/** CodeMirror with the query theme: 14px Geist Mono at 1.4, a 13px line-number gutter and an empty lint gutter. */
function Editor() {
  return (
    <div className="flex bg-editor-background font-mono text-[14px] leading-[1.4] text-editor-foreground">
      <div className="flex shrink-0 py-1 text-[13px] text-editor-comment">
        <div>
          {lines.map((_, i) => (
            <div key={i} className="h-[19.6px] pl-[5px] pr-[3px] text-right leading-[19.6px]">
              {i + 1}
            </div>
          ))}
        </div>
        <div className="w-[18.2px]" />
      </div>
      <div className="grow py-1">
        {lines.map((line, i) => (
          <div key={i} className="h-[19.6px] whitespace-pre pl-1.5 pr-0.5">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A Tabs.tsx underline tab. */
function Tab({
  label,
  active,
  disabled,
  className = "",
}: {
  label: ReactNode;
  active?: boolean;
  /** Graph and Big number stay disabled until a query has results. */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`group flex flex-col items-center pt-1 ${disabled ? "opacity-50" : ""} ${className}`}
    >
      <span className={`text-sm ${active ? "text-text-bright" : "text-text-dimmed"}`}>{label}</span>
      <div
        className={`mt-1 h-0.5 w-full ${active ? "bg-indigo-500" : "bg-surface-control-active opacity-0"}`}
      />
    </div>
  );
}

const prompts = [
  "Show me failed runs by hour for the past 7 days",
  "Count of runs by status by hour for the past 48h",
  "Top 50 most expensive runs this week",
  "Average execution duration by task this week",
  "Run counts by tag in the past 7 days",
  "CPU utilization over time by task",
  "Peak memory usage per run",
];

const pill =
  "flex items-center h-6 bg-secondary rounded pl-1.5 gap-1.5 text-xs divide-x divide-black/15 shadow-xs text-text-bright border border-border-bright/50 pr-2";

export function QueryFigure() {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <PageHeader title="Query" />
      <div className="flex h-full min-h-0 w-full bg-background-bright">
        <div className="flex h-full w-[597px] shrink-0 flex-col">
          <div className="h-[300px] shrink-0">
            <div className="flex h-full flex-col gap-2 bg-white pb-2 dark:bg-background-deep">
              <div className="relative flex h-full min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Editor />
                </div>
                <div className="absolute right-0 top-0 z-10 flex items-center justify-end bg-background-deep/80 light:bg-white/80 p-1.5">
                  <Button
                    variant="minimal"
                    className="flex-none"
                    shortcut={
                      <>
                        <span>⇧</span>
                        <span>⌥</span>
                        <span>f</span>
                      </>
                    }
                  >
                    Format
                  </Button>
                  <Button variant="minimal" trailingIcon={I.TrashIcon}>
                    Clear
                  </Button>
                  <Button variant="minimal" trailingIcon={I.ClipboardSolidIcon}>
                    Copy
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 px-2">
                {/* The mark sits on the wrapper: inside the dimmed button the ring would fade too. */}
                <span data-mark="history" data-mark-badge="below" className="flex">
                  {/* Secondary, disabled until there is history: bg-tertiary and opacity-60. */}
                  <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs border border-border-bright/50 shadow-xs bg-tertiary opacity-60">
                    <div className="relative flex w-full items-center">
                      <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
                        <I.ClockRotateLeftIcon className="h-3.5 -ml-1 -mr-1.5 text-text-bright shrink-0 justify-start" />
                        <span className="mx-auto grow self-center truncate">History</span>
                      </div>
                    </div>
                  </div>
                </span>
                <div className="flex items-center gap-1.5">
                  <Button variant="minimal">Explain</Button>
                  <div data-mark="scope" className={pill}>
                    <div className="flex items-start leading-4 gap-0.5">
                      <div className="mt-[-0.5px] flex items-center gap-1.5">
                        <div className="text-text-bright">
                          <span>Scope</span>:
                        </div>
                      </div>
                      <div className="text-text-dimmed">
                        <span className="flex items-center gap-1">
                          <I.DevelopmentIcon className="text-dev size-4" />
                          <span className="truncate text-left text-dev">Development</span>
                        </span>
                      </div>
                    </div>
                  </div>
                  <div data-mark="period" className={pill}>
                    <div className="flex items-start leading-4 gap-1.5">
                      <div className="mt-[-0.5px] flex items-center gap-1.5">
                        <I.CalendarIcon className="size-4" />
                      </div>
                      <div className="text-text-bright">7 days</div>
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    mark="query"
                    markBadge="below"
                    shortcut={
                      <>
                        <span>⌘</span>
                        <I.KeyboardEnterIcon className="w-2.5 h-4" />
                      </>
                    }
                  >
                    Query
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <div className="relative h-0.75 w-full shrink-0 before:absolute before:left-0 before:top-px before:h-px before:w-full before:bg-grid-bright" />
          <div className="min-h-0 flex-1 overflow-hidden bg-background-bright">
            <div className="grid h-full max-h-full min-h-0 grid-rows-[auto_1fr] overflow-hidden">
              <div className="flex gap-x-6 border-b border-grid-bright shrink-0 overflow-hidden pl-3 pr-1">
                <Tab label="Table" active />
                <Tab label="Graph" disabled />
                <Tab label="Big number" disabled />
              </div>
              <div className="m-0 min-h-0 overflow-y-hidden">
                <div className="flex h-full flex-col items-center justify-center gap-3">
                  <I.ChartHistogramIcon className="size-16 text-secondary" />
                  <div className="font-sans text-base font-medium max-w-48 text-center text-text-dimmed">
                    Run a query to visualize the results.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="relative flex h-full w-0.75 shrink-0 items-center justify-center before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright">
          <div className="relative z-1 flex h-5 w-0.75 flex-col items-center justify-center gap-0.75 bg-background-dimmed">
            <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
            <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
            <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {/* overflow-hidden dropped on this panel: it would clip the help and ai marks. */}
          <div className="grid h-full max-h-full grid-rows-[auto_1fr] bg-background-bright">
            <div className="flex min-h-0 flex-col pt-1">
              <div className="h-fit">
                <div
                  data-mark="help"
                  data-mark-badge="left"
                  className="flex gap-x-6 border-b border-grid-bright mx-3 shrink-0"
                >
                  <Tab
                    className="shrink-0"
                    active
                    label={
                      <div className="flex items-center gap-0.5">
                        <I.AISparkleIcon className="size-4" />
                        AI
                      </div>
                    }
                  />
                  <Tab className="shrink-0" label="Writing TRQL" />
                  <Tab className="shrink-0" label="Table schema" />
                  <Tab className="shrink-0" label="Examples" />
                </div>
              </div>
              <div className="mt-1 min-h-0 flex-1">
                <div className="min-w-64 p-3">
                  <div className="space-y-2">
                    <div data-mark="ai" data-mark-badge="left" className="flex flex-col">
                      <div
                        className="overflow-hidden rounded-md p-px"
                        style={{ background: "linear-gradient(to bottom right, #E543FF, #286399)" }}
                      >
                        <div className="overflow-hidden rounded-md bg-background-bright">
                          <div className="h-[180px] px-3 py-2.5 text-sm text-text-dimmed">
                            e.g. show me failed runs from the last 7 days
                          </div>
                          <div className="flex justify-end gap-2 px-2 pb-2">
                            {(
                              [
                                ["New query", I.PlusIcon, "gap-1.5"],
                                ["Edit query", I.PencilSquareIcon, "gap-2"],
                              ] as const
                            ).map(([label, Icon, gap]) => (
                              <div
                                key={label}
                                className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-tertiary opacity-60"
                              >
                                <div className="relative flex w-full items-center">
                                  <div
                                    className={`justify-center flex w-full items-center text-text-bright ${gap}`}
                                  >
                                    <Icon className="h-3.5 -mx-1 text-text-bright shrink-0 justify-start" />
                                    <span className="mx-auto grow self-center truncate">
                                      {label}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="pt-4">
                      <div className="font-sans text-sm leading-5 font-semibold mb-3 text-text-bright">
                        Example prompts
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {prompts.map((p) => (
                          <div
                            key={p}
                            className="group flex w-fit items-center gap-2 rounded-full border border-dashed border-border-bright px-4 py-2"
                          >
                            <I.SparkleListIcon className="size-4 shrink-0 text-text-dimmed" />
                            <div className="font-sans text-sm font-medium text-text-dimmed text-left">
                              {p}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The Runs page in Development at 1440px wide, side menu cropped off: header, filters and toolbar,
// and the runs table, which is wider than the page and cut off on the right under the sticky row
// menu. Drawn from source (the test dashboard had no runs); the webapp files it mirrors are its
// `sources` in lib/dashboard-figures.ts. The parts are exported for the figures that open
// something on this page (the row menu, the tags filter, the bulk action panel).
import type { ReactNode } from "react";
import {
  Button,
  Cell,
  PageHeader,
  Pagination,
  secondarySmall,
  tableHeader,
  tableRow,
  td,
  th,
} from "./chrome";
import * as I from "./icons";

export type Run = {
  id: string;
  task: string;
  root: boolean;
  status?: "completed" | "failed" | "delayed" | "expired";
  version?: string;
  current?: boolean;
  started: string;
  queued: string;
  duration: string;
  compute: string;
  test?: boolean;
  created: string;
  delayedUntil?: string;
};

const runs: Run[] = [
  {
    // Triggered with `delay: "1h"`: no version, machine or start yet, and the queued timer runs.
    id: "w9b3lx7e",
    task: "hello-world",
    root: true,
    status: "delayed",
    started: "–",
    queued: "2m 4s",
    duration: "–",
    compute: "–",
    created: "25 Nov 2026, 10:44:30 am",
    delayedUntil: "25 Nov 2026, 11:44:30 am",
  },
  {
    id: "p3s8wq2k",
    task: "child-task",
    root: false,
    version: "20261125.4",
    current: true,
    started: "25 Nov 2026, 10:42:21 am",
    queued: "212ms",
    duration: "3.2s",
    compute: "3.1s",
    created: "25 Nov 2026, 10:42:21 am",
  },
  {
    id: "t6c0vj4n",
    task: "hello-world",
    root: true,
    version: "20261125.4",
    current: true,
    started: "25 Nov 2026, 10:42:19 am",
    queued: "1.1s",
    duration: "5.6s",
    compute: "2.4s",
    created: "25 Nov 2026, 10:42:18 am",
  },
  {
    id: "m2r7ezq9",
    task: "hello-world",
    root: true,
    status: "failed",
    version: "20261125.3",
    started: "25 Nov 2026, 9:58:05 am",
    queued: "1.4s",
    duration: "12s",
    compute: "11.8s",
    created: "25 Nov 2026, 9:58:04 am",
  },
  {
    // Reached its 10m TTL while no dev CLI was connected: it never started.
    id: "k4v8gs2c",
    task: "hello-world",
    root: true,
    status: "expired",
    started: "–",
    queued: "10m",
    duration: "–",
    compute: "–",
    created: "25 Nov 2026, 9:40:12 am",
  },
  {
    id: "h8d4ya1x",
    task: "child-task",
    root: false,
    version: "20261125.3",
    started: "25 Nov 2026, 9:31:47 am",
    queued: "198ms",
    duration: "3.1s",
    compute: "3s",
    test: true,
    created: "25 Nov 2026, 9:31:47 am",
  },
  {
    id: "f5k1nb6u",
    task: "hello-world",
    root: true,
    version: "20261125.3",
    started: "25 Nov 2026, 9:31:45 am",
    queued: "1.2s",
    duration: "5.5s",
    compute: "2.3s",
    test: true,
    created: "25 Nov 2026, 9:31:44 am",
  },
];

// The checkbox: a native input styled by @tailwindcss/forms (1rem square).
const checkbox =
  "inline-block size-4 align-middle rounded-sm border border-border-bright bg-transparent";
const badge =
  "grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright text-blue-500 whitespace-nowrap";

/** TableHeaderCell with a tooltip: the label, then an info icon. */
function Info({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      {children}
      <span className="h-fit">
        <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
      </span>
    </div>
  );
}

const statuses = {
  completed: { icon: I.CheckCircleIcon, color: "text-success", label: "Completed" },
  failed: { icon: I.XCircleIcon, color: "text-error", label: "Failed" },
  delayed: { icon: I.ClockIcon, color: "text-text-faint", label: "Delayed" },
  expired: { icon: I.TrashIcon, color: "text-text-faint", label: "Expired" },
};

function Status({ status = "completed" }: { status?: Run["status"] }) {
  const { icon: Icon, color, label } = statuses[status];
  return (
    <span
      data-mark={status === "delayed" || status === "expired" ? `status-${status}` : undefined}
      className="flex items-center gap-1"
    >
      <Icon className={`${color} h-4 w-4`} />
      <span className={color}>{label}</span>
    </span>
  );
}

/** The checkbox: a native input styled by @tailwindcss/forms (checked: indigo with its check). */
function Checkbox({ checked }: { checked?: boolean }) {
  return checked ? (
    <span className="inline-grid size-4 place-items-center align-middle rounded-sm border border-transparent bg-indigo-500">
      <svg viewBox="0 0 16 16" fill="white" className="size-4">
        <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
      </svg>
    </span>
  ) : (
    <span className={checkbox} />
  );
}

/** NavBar with PageTitle "Runs" (its help tooltip icon) and the Runs docs button. */
export function RunsHeader() {
  return (
    <PageHeader
      title="Runs"
      accessory={
        <div className="h-fit">
          <I.QuestionMarkIcon className="size-4 text-text-dimmed" />
        </div>
      }
    >
      <Button variant="docs" icon={I.BookIcon}>
        Runs docs
      </Button>
    </PageHeader>
  );
}

// A secondary/small filter chip (RunFilters.tsx), as the permanent Status and Tasks filters draw it.
const chip =
  "flex h-6 items-center rounded border border-border-bright/50 shadow-xs bg-secondary pl-1 pr-2 text-xs text-text-bright";
/** The filters (RunFilters.tsx RunsFilters) and the toolbar on the right. */
export function RunsToolbar({
  selected = 0,
  bulkHidden,
  moreFilters,
}: {
  /** Selected runs: Bulk action shows their count. */
  selected?: number;
  /** The bulk action panel is open: Bulk action stays in place, invisible. */
  bulkHidden?: boolean;
  /** Drawn under More filters, e.g. an open filter dropdown. */
  moreFilters?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-x-2 p-2">
      <div className="flex flex-row flex-wrap items-center gap-1.5">
        {/* AIFilterInput: secondary-small Input, sized by min-w-44 (the input is absolute). */}
        <div className="relative h-6 min-w-44">
          <div className="absolute inset-0 left-0 top-0 h-6">
            <div className="flex items-center px-1 h-6 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg">
              <div className="flex items-center">
                <I.AISparkleIcon className="size-4" />
              </div>
              <span className="grow flex items-center h-full w-full px-1 rounded text-xs text-text-dimmed">
                Describe your filters…
              </span>
            </div>
          </div>
        </div>
        <div className={`${chip} gap-1`}>
          <div className="grid size-4 place-items-center">
            <div className="size-[75%] rounded-full border-2 border-text-bright" />
          </div>
          <span>Status</span>
        </div>
        <div className={`${chip} gap-1.5`}>
          <I.TasksIcon className="size-4" />
          <span>Tasks</span>
        </div>
        <div className="group">
          <div className="flex items-center h-6 bg-secondary rounded pl-1.5 gap-1.5 text-xs divide-x divide-black/15 shadow-xs text-text-bright border border-border-bright/50 pr-2">
            <div className="flex items-start leading-4 gap-0.5">
              <div className="mt-[-0.5px] flex items-center gap-1.5">
                <I.CalendarIcon className="size-4" />
                <div className="text-text-bright">
                  <span>Created</span>:
                </div>
              </div>
              <div className="text-text-dimmed">
                <div>7 days</div>
              </div>
            </div>
          </div>
        </div>
        {/* Switch, secondary/small, off. */}
        <div className="flex items-center h-6 gap-x-1.5 rounded pr-1 py-[0.1rem] pl-1.5 text-text-dimmed border border-border-bright/50 shadow-xs bg-secondary">
          <span className="whitespace-nowrap text-xs text-text-bright">Root only</span>
          <div className="inline-flex shrink-0 items-center rounded-full border-2 border-transparent h-3 w-5.5 bg-surface-control-hover">
            <span className="h-2.5 w-2.5 block rounded-full bg-white dark:bg-charcoal-200" />
          </div>
        </div>
        {/* FilterMenu's SelectTrigger; its shortcut is only in the tooltip. */}
        <div className="relative">
          <div
            data-mark="more-filters"
            className="group flex items-center gap-1 h-6 rounded text-xs bg-secondary border border-border-bright/50 shadow-xs text-text-bright pl-1 pr-2"
          >
            <div className="flex min-w-0 grow items-center gap-0.5 overflow-hidden">
              <div className="flex-none">
                <div className="flex size-4 items-center justify-center">
                  <I.PlusIcon className="size-3.5" />
                </div>
              </div>
              <div className="min-w-0 truncate">More filters</div>
            </div>
          </div>
          {moreFilters}
        </div>
      </div>
      <div className="flex items-center justify-end gap-x-1.5">
        <div
          data-mark="bulk-action"
          className={`${secondarySmall} ${selected > 0 ? "pl-2.5 pr-1" : "px-2.5"} ${bulkHidden ? "invisible" : ""}`}
        >
          <div className="relative flex w-full items-center">
            <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
              <I.ListCheckedIcon className="h-3.5 -mx-1 text-text-bright shrink-0 justify-start" />
              <span className="flex items-center gap-x-1 whitespace-nowrap text-text-bright">
                <span>Bulk action</span>
                {selected > 0 && (
                  <div className="grid place-items-center rounded-full px-1.5 h-4 text-xxs border bg-blue-600 text-white uppercase whitespace-nowrap">
                    <span>{selected}</span>
                  </div>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="flex">
          <Button icon={I.ColumnsIcon}>Columns</Button>
        </div>
        <Pagination />
      </div>
    </div>
  );
}

/** TaskRunsTable. `menu` is drawn beside the Failed run's menu button (an open row menu); the
 * cell gets z-10 so the rows below don't paint over it (the dashboard portals the popover). */
export function RunsTable({
  rows = runs,
  selectable = true,
  topBorder = true,
  selected = [],
  menu,
}: {
  rows?: Run[];
  /** The checkbox column (allowSelection): off where the table only lists runs. */
  selectable?: boolean;
  topBorder?: boolean;
  selected?: string[];
  menu?: ReactNode;
}) {
  // overflow-x-auto in the dashboard: the sticky menu column stays at the right edge.
  return (
    <div className={`whitespace-nowrap overflow-hidden ${topBorder ? "border-t" : ""}`}>
      <div className="table w-full">
        <div className={tableHeader}>
          <div className={tableRow}>
            {selectable && (
              <div className={th.replace("px-3", "pl-3 pr-0")}>
                <span className={checkbox} />
              </div>
            )}
            <div className={th}>ID</div>
            <div className={th}>Task</div>
            <div className={th}>
              <Info>Status</Info>
            </div>
            <div className={th}>Version</div>
            <div className={th}>Started</div>
            {/* colSpan={3} in the dashboard; a div table has no colspan, so the label
                overflows its zero-width box into the next two columns instead. */}
            <div className={th}>
              <div className="w-0">
                <Info>Duration</Info>
              </div>
            </div>
            <div className={th} />
            <div className={th} />
            <div className={th}>Compute</div>
            <div className={th.replace("px-3", "pl-4 pr-3")}>
              <Info>Machine</Info>
            </div>
            <div className={th}>Queue</div>
            <div className={th}>Test</div>
            <div className={th}>Created at</div>
            <div className={th}>
              <Info>Delayed until</Info>
            </div>
            <div className={th}>
              <Info>TTL</Info>
            </div>
            <div className={th}>
              <Info>Tags</Info>
            </div>
            <div className={th} />
          </div>
        </div>
        <div className="table-row-group relative">
          {rows.map((run) => (
            <div key={run.id} className={tableRow}>
              {selectable && (
                <div className={`${td} py-3 pl-3 pr-0 text-left`}>
                  <Checkbox checked={selected.includes(run.id)} />
                </div>
              )}
              <Cell>
                <span className="flex h-6 items-center gap-1">
                  <span className="group relative inline-flex h-6 items-center font-mono">
                    <span>{run.id}</span>
                  </span>
                </span>
              </Cell>
              <Cell>
                <span className="flex items-center gap-x-1">
                  <I.TaskSmallIcon className="min-w-4.5 text-tasks size-3.5 flex-none" />
                  {run.task}
                  {run.root && (
                    <div className={badge}>
                      <span>Root</span>
                    </div>
                  )}
                </span>
              </Cell>
              <Cell>
                <span className={run.root ? "inline-flex min-w-full items-center" : "h-fit"}>
                  <Status status={run.status} />
                </span>
              </Cell>
              {run.version ? (
                <Cell>
                  <span className="group inline-flex items-center gap-1.5">
                    <span className="underline decoration-charcoal-500 decoration-dotted underline-offset-4">
                      {run.version}
                    </span>
                    {run.current && (
                      <div className={badge}>
                        <span>Current</span>
                      </div>
                    )}
                  </span>
                </Cell>
              ) : (
                <Cell>–</Cell>
              )}
              <Cell>
                <span>{run.started}</span>
              </Cell>
              <Cell className="w-[1%]" pad="pl-3 pr-0 py-3 tabular-nums">
                <div className="flex items-center gap-1">
                  <I.RectangleStackIcon className="size-4 text-text-dimmed" />
                  {run.queued}
                </div>
              </Cell>
              <Cell className="w-[1%]" pad="px-4 py-3 tabular-nums">
                <div className="flex items-center gap-1">
                  <I.ClockIcon className="size-4 text-blue-500" />
                  {run.duration}
                </div>
              </Cell>
              <Cell pad="pl-0 pr-3 py-3 tabular-nums">
                <div className="flex items-center gap-1">
                  <I.CpuChipIcon className="size-4 text-success" />
                  {run.compute}
                </div>
              </Cell>
              <Cell className="tabular-nums">–</Cell>
              <Cell>
                <span className="flex items-center gap-1">
                  {run.version ? (
                    <I.MachineSmall1xIcon className="size-5" />
                  ) : (
                    <I.MachineNoMachineIcon className="size-5" />
                  )}
                  <span className="text-text-dimmed">
                    {run.version ? "Small 1x" : "No machine yet"}
                  </span>
                </span>
              </Cell>
              <Cell>
                <span className="h-fit w-fit">
                  <span className="flex items-center gap-1">
                    <I.TasksIcon className="size-[1.125rem] text-blue-500" />
                    <span>{run.task}</span>
                  </span>
                </span>
              </Cell>
              <Cell>{run.test ? <I.CheckIcon className="size-4 text-text-dimmed" /> : "–"}</Cell>
              <Cell>
                <span>{run.created}</span>
              </Cell>
              <Cell>{run.delayedUntil ? <span>{run.delayedUntil}</span> : "–"}</Cell>
              <Cell>10m</Cell>
              <Cell className="pr-16" pad="px-3 py-1">
                <div className="flex gap-1">–</div>
              </Cell>
              {/* TableCellMenu, sticky to the right edge. The Replay and Cancel buttons beside
                  the menu only show on hover. */}
              <div
                className={`${td} text-right sticky right-0 bg-background-dimmed ${menu && run.status === "failed" ? "z-10" : ""}`}
              >
                <div className="relative h-full p-1">
                  <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
                    <div
                      data-mark={run.status === "failed" ? "actions" : undefined}
                      data-mark-badge={run.status === "failed" ? "left" : undefined}
                      className="group flex items-center justify-center size-6 rounded-[3px] text-text-dimmed"
                    >
                      <I.EllipsisVerticalIcon className="size-5" />
                    </div>
                    {run.status === "failed" && menu}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RunsListFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunsHeader />
      <RunsToolbar />
      <RunsTable />
    </div>
  );
}

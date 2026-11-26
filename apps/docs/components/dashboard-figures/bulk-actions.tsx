// A bulk action's page once it has finished: the replay created by the bulk-action-create figure
// (the two selected runs, replayed into Development). The header with View runs and Replay new
// runs, the New runs tab listing the two new runs (the runs table from runs-list.tsx, cut off on
// the right), and the rail with Progress at the top, cut off at the bottom as in a 900px-tall
// window. The page frame and rail are copied from the dashboard's detail-page storybook ("Bulk
// action"); the finished state is drawn from the route. The webapp files it mirrors are its
// `sources` in lib/dashboard-figures.ts.
import { ClipboardIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, EnvCombo, PageHeader, Pagination } from "./chrome";
import * as I from "./icons";
import { type Run, RunsTable } from "./runs-list";
import { Copyable, Group, Property, ResizableHandle, Tab } from "./detail-parts";

const TITLE = "Replay of 2 runs";

const newRuns: Run[] = [
  {
    id: "q7n2hx5d",
    task: "hello-world",
    root: true,
    version: "20261125.4",
    current: true,
    started: "25 Nov 2026, 10:46:14 am",
    queued: "1.2s",
    duration: "5.4s",
    compute: "2.3s",
    created: "25 Nov 2026, 10:46:13 am",
  },
  {
    // A replay has no parent run, so the replayed child-task run is a root run.
    id: "c9w4kt1z",
    task: "child-task",
    root: true,
    version: "20261125.4",
    current: true,
    started: "25 Nov 2026, 10:46:13 am",
    queued: "301ms",
    duration: "3.1s",
    compute: "3s",
    created: "25 Nov 2026, 10:46:13 am",
  },
];

const dot = <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />;
const meta = "flex shrink-0 items-center gap-1 has-[.truncate]:min-w-0 has-[.truncate]:shrink";

function Completed() {
  return (
    <span className="flex items-center gap-1">
      <I.CheckCircleIcon className="text-success h-4 w-4" />
      <span className="system-mono-label text-success">Completed</span>
    </span>
  );
}

function Replay({ iconClassName = "h-4 w-4" }: { iconClassName?: string }) {
  return (
    <span className="flex items-center gap-1">
      <I.ArrowPathIcon className={`text-indigo-500 ${iconClassName}`} />
      <span className="text-text-dimmed">Replay</span>
    </span>
  );
}

/** ProgressMeter's legend entry. */
function Legend({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block size-2 rounded-[1px] ${color}`} />
      {children}
    </span>
  );
}

function Rail() {
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden bg-background-bright pb-4 pt-1">
      <Group title="Progress">
        <div data-mark="progress" data-mark-badge="below" className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-text-bright">Runs processed</span>
            <span className="tabular-nums text-text-dimmed">2 / 2</span>
          </div>
          <div className="relative h-3.5 w-full overflow-hidden rounded-sm bg-background-deep">
            <div className="absolute top-0 h-full bg-success" style={{ width: "100%", left: 0 }} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-text-dimmed">
            <Legend color="bg-success">2 replayed successfully</Legend>
            <Legend color="bg-error">0 failed</Legend>
          </div>
        </div>
      </Group>
      <Group title="Details">
        <Property label="ID">
          <Copyable value="bulk_8kd3wq7m2x" />
        </Property>
        <div className="flex flex-col gap-y-3">
          <Property label="Status">
            <Completed />
          </Property>
          <Property label="Type">
            <Replay />
          </Property>
        </div>
        <Property label="Created">
          <span className="truncate">25 Nov 2026, 10:46:12 am</span>
        </Property>
        <Property label="Completed">
          <span className="truncate">25 Nov 2026, 10:46:15 am</span>
        </Property>
        <div className="flex flex-col gap-y-3">
          <Property label="Duration">
            <span className="truncate">3s</span>
          </Property>
          <Property label="Created by">
            <span className="flex min-w-0 items-center gap-1.5">
              <I.AccountIcon className="aspect-square text-text-dimmed size-4" />
              <span className="truncate">Dev Patel</span>
            </span>
          </Property>
        </div>
      </Group>
      <Group title="Selection">
        <Property label="Runs">
          <span className="truncate">2 runs selected</span>
        </Property>
        <Property label="Replayed into">
          <EnvCombo env="dev" />
        </Property>
        <div className="flex flex-col gap-y-3">
          <Property label="Version">
            <span className="truncate">Current version</span>
          </Property>
          <Property label="Region">
            <span className="truncate">Same as original run</span>
          </Property>
        </div>
      </Group>
    </div>
  );
}

export function BulkActionsFigure() {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
      <PageHeader crumbs={["Bulk actions"]} title={TITLE} detail />
      <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
        <div className="flex items-end gap-4 border-b border-grid-bright bg-background-bright px-4 pb-3 pt-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid size-[46px] flex-none place-items-center rounded-md bg-background-hover">
              <I.ListCheckedIcon className="size-5 text-bulkActions" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="truncate min-w-0 text-text-bright text-lg font-semibold leading-6 tracking-tight">
                  {TITLE}
                </span>
                <div className="flex flex-none items-center gap-1 rounded size-6 justify-center text-text-faint">
                  <ClipboardIcon className="size-3.5" />
                </div>
                <div className="flex flex-none items-center text-sm">
                  <Completed />
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-text-dimmed">
                <span className={meta}>
                  {/* iconClassName size-3.5: tailwind-merge drops the combo's h-4 w-4. */}
                  <Replay iconClassName="size-3.5" />
                </span>
                {dot}
                <span className={meta}>2 runs</span>
                {dot}
                <span className={meta}>Started 2m ago by Dev Patel</span>
              </div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              icon={I.RunsIcon}
              iconClassName="-mx-1 text-runs"
              mark="view-runs"
              markBadge="below"
            >
              View runs
            </Button>
            <Button
              icon={I.ArrowPathIcon}
              iconClassName="-mx-1 text-indigo-500"
              mark="replay"
              markBadge="below"
            >
              Replay new runs
            </Button>
            {/* danger/small, disabled: the bulk action has already completed. */}
            <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-error opacity-50">
              <div className="relative flex w-full items-center">
                <div className="justify-center flex w-full items-center text-white/80 gap-x-2.5">
                  <I.NoSymbolIcon className="h-3.5 -mx-1 text-white shrink-0 justify-start" />
                  <span className="mx-auto grow self-center truncate">Abort…</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex h-10 shrink-0 border-b border-grid-bright items-stretch gap-x-3 bg-background-bright px-4">
          <div className="flex min-w-0 flex-1 items-stretch gap-x-5">
            <Tab label="New runs" count="2" selected />
            <Tab label="Failed" count="0" />
          </div>
        </div>
        <div className="flex w-full overflow-hidden h-full max-h-full">
          <div className="min-w-0 flex-1">
            <div className="h-full min-h-0 overflow-hidden">
              <div className="flex h-full flex-col overflow-hidden">
                <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright px-3 py-1.5">
                  <div className="flex min-w-0 items-center gap-2" />
                  <div className="flex flex-none items-center gap-1.5">
                    <Button variant="tertiary" icon={I.RunsIcon} iconClassName="-mx-1 text-runs">
                      Open in runs list
                    </Button>
                    <Pagination />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <RunsTable rows={newRuns} selectable={false} topBorder={false} />
                </div>
              </div>
            </div>
          </div>
          <ResizableHandle />
          <div className="min-w-0" style={{ width: 320 }}>
            <Rail />
          </div>
        </div>
      </div>
    </div>
  );
}

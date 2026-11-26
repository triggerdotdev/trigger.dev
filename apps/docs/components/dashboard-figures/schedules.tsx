// A scheduled task's page with the Schedules tab open: the header with Test task, the schedules
// table with Create schedule, the usage bar, and the property rail (cut off at the bottom). The
// page frame is copied from the dashboard's detail-page storybook; the task's content is drawn
// from source (the test dashboard has no tasks). The webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import {
  ArrowsRightLeftIcon,
  ArrowUpCircleIcon,
  BellAlertIcon,
  CheckIcon,
} from "@heroicons/react/20/solid";
import { ClipboardIcon } from "lucide-react";
import { Button, Cell, PageHeader, tableRow, th } from "./chrome";
import * as I from "./icons";
import { Copyable, Group, Property, ResizableHandle, Tab } from "./detail-parts";
import { ScheduleClockIcon } from "./task-parts";

const TASK = "first-scheduled-task";

function Rail() {
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden bg-background-bright pb-4 pt-1">
      <Group title="Details">
        <Property label="Identifier">
          <Copyable value={TASK} />
        </Property>
        <div className="flex flex-col gap-y-3">
          <Property label="Type">
            <span className="truncate">
              <span className="flex items-center gap-1.5">
                <ScheduleClockIcon className="size-4 text-schedules" />
                Scheduled task
              </span>
            </span>
          </Property>
          <Property label="Created">
            <span className="truncate">3 Nov 2026, 9:14:05 am</span>
          </Property>
        </div>
      </Group>
      <Group title="Execution">
        <Property label="Queue">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs text-text-link">task/{TASK}</span>
          </span>
        </Property>
        <div className="flex flex-col gap-y-3">
          <Property label="Concurrency">
            <span className="truncate">0 of 10 running</span>
          </Property>
          <Property label="Machine">
            <span className="truncate">
              <span className="flex items-center gap-1">
                <I.MachineSmall1xIcon className="size-5" />
                <span className="text-text-dimmed">Small 1x</span>
              </span>
            </span>
          </Property>
          <Property label="Max duration">
            <span className="truncate">–</span>
          </Property>
          <Property label="TTL">
            <span className="truncate">–</span>
          </Property>
        </div>
      </Group>
    </div>
  );
}

export function SchedulesFigure() {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
      <PageHeader crumbs={["Tasks"]} title={TASK} detail />
      <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
        <div className="flex items-end gap-4 border-b border-grid-bright bg-background-bright px-4 pb-3 pt-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid size-[46px] flex-none place-items-center rounded-md bg-background-hover">
              <ScheduleClockIcon className="size-5 text-schedules" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="truncate min-w-0 text-text-bright font-mono text-[1.0625rem] font-medium leading-6">
                  {TASK}
                </span>
                <div className="flex flex-none items-center gap-1 rounded size-6 justify-center text-text-faint">
                  <ClipboardIcon className="size-3.5" />
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-text-dimmed">
                <span className="flex shrink-0 items-center gap-1">Scheduled task</span>
                <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
                <span className="flex shrink-0 items-center gap-1">
                  <span className="inline-flex items-center gap-1">Version 20261125.3</span>
                </span>
                <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
                <span className="flex shrink-0 items-center gap-1">
                  <span className="truncate">
                    <span className="tabular-nums">0</span> running,{" "}
                    <span className="tabular-nums">0</span> queued
                  </span>
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button icon={BellAlertIcon} iconClassName="-mx-1 text-alerts">
              Watch
            </Button>
            <Button icon={I.RunsIcon} iconClassName="-mx-1 text-runs">
              View runs
            </Button>
            <Button
              variant="primary"
              icon={I.BeakerIcon}
              iconClassName="-mx-2"
              className="[&>div>div]:gap-x-2"
              mark="test-task"
              markBadge="below"
            >
              Test task
            </Button>
          </div>
        </div>
        <div className="flex h-10 shrink-0 border-b border-grid-bright items-stretch gap-x-3 bg-background-bright px-4">
          <div className="flex min-w-0 flex-1 items-stretch gap-x-5">
            <Tab label="Runs" />
            <Tab label="Queue" count="0" />
            <Tab label="Schedules" count="1" selected mark="schedules-tab" />
          </div>
        </div>
        <div className="flex w-full overflow-hidden h-full max-h-full">
          <div className="min-w-0 flex-1">
            <div className="h-full min-h-0 overflow-hidden">
              <div className="grid h-full grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
                <div className="flex h-full flex-col overflow-hidden">
                  <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2" />
                    <div className="flex flex-none items-center gap-1.5">
                      <Button
                        variant="primary"
                        icon={I.PlusIcon}
                        mark="create-schedule"
                        markBadge="left"
                      >
                        Create schedule
                      </Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <div className="whitespace-nowrap overflow-visible">
                      <div className="table w-full">
                        <div className="table-header-group sticky top-0 z-10 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright bg-background-dimmed">
                          <div className={tableRow}>
                            <div className={th}>Schedule</div>
                            <div className={th}>Cron</div>
                            <div className={th}>Window</div>
                            <div className={th}>External ID</div>
                            <div className={th}>Next run</div>
                            <div className={th}>Last run</div>
                            <div className={th}>Status</div>
                          </div>
                        </div>
                        <div className="table-row-group relative">
                          <div className="table-row group relative w-full after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px after:bg-grid-dimmed">
                            <Cell>
                              <span className="inline-flex flex-col gap-0.5">
                                <span className="truncate max-w-32 font-mono text-xs">
                                  sched_4f8x2k9m1q
                                </span>
                                <div className="flex items-center space-x-1 text-xs text-text-dimmed">
                                  <ArrowsRightLeftIcon className="size-4" />
                                  <span>Imperative</span>
                                </div>
                              </span>
                            </Cell>
                            <Cell>
                              <span className="inline-flex flex-col">
                                <span className="font-mono text-xs">0 9 * * *</span>
                                <span className="text-xs text-text-dimmed">UTC</span>
                              </span>
                            </Cell>
                            <Cell>
                              <span className="text-xs">–</span>
                            </Cell>
                            <Cell>
                              <span className="text-text-dimmed">–</span>
                            </Cell>
                            <Cell>
                              <span className="inline-flex flex-col whitespace-nowrap">
                                <span>26 Nov 2026, 9:00:00 am</span>
                                <span className="text-text-dimmed">in about 14 hours</span>
                              </span>
                            </Cell>
                            <Cell>
                              <span>About 10 hours ago</span>
                            </Cell>
                            <Cell>
                              <div className="flex items-center gap-1 text-xs text-success">
                                <CheckIcon className="size-4" />
                                Enabled
                              </div>
                            </Cell>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                {/* SchedulesUsageBar */}
                <div className="flex w-full items-start justify-between">
                  <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
                    <div className="size-6">
                      <svg className="h-full w-full -rotate-90 overflow-visible">
                        <circle
                          className="fill-none stroke-grid-bright"
                          strokeWidth="4"
                          r="10"
                          cx="12"
                          cy="12"
                        />
                        <circle
                          className="fill-none stroke-success"
                          strokeWidth="4"
                          r="10"
                          cx="12"
                          cy="12"
                          strokeDasharray={`${0.1 * 62.8} 62.8`}
                          strokeDashoffset="0"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                    <div className="flex w-full items-center justify-between gap-6">
                      <div className="flex items-center gap-1">
                        <div className="font-sans text-sm leading-5 font-semibold text-text-bright">
                          You've used 1/10 of your schedules
                        </div>
                        <I.InformationCircleIcon className="size-4 text-text-dimmed" />
                      </div>
                      <Button icon={ArrowUpCircleIcon} iconClassName="-mx-1 text-indigo-500">
                        Upgrade
                      </Button>
                    </div>
                  </div>
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

// The New schedule dialog opened from a scheduled task's page, with a cron pattern typed in: the
// fields on the left, the next five runs on the right, cut off where the dialog scrolls. The fields
// are copied from the rendered dashboard (the full-page form); the dialog layout, the Generate
// field (shown on cloud) and the footer are drawn from source. The webapp files it mirrors are its
// `sources` in lib/dashboard-figures.ts. The form's max-h-[min(44rem,80vh)] is written as 44rem, its
// height in a 900px-tall window (80vh would follow the docs window instead).
import { CheckIcon } from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import { Button, EnvCombo } from "./chrome";
import { DialogFrame, Input, Select } from "./form-parts";
import * as I from "./icons";

const TASK = "first-scheduled-task";

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const group = "grid w-full items-center gap-1.5 max-w-md";
const hint = "font-sans text-xs font-medium text-text-dimmed";

function Optional({ children }: { children: ReactNode }) {
  return (
    <span className={label}>
      {children}
      <span className="text-text-dimmed">(optional)</span>
    </span>
  );
}

const nextRuns = [
  ["26 Nov 2026, 9:00 am", "in 19h 24m"],
  ["27 Nov 2026, 9:00 am", "+24h"],
  ["28 Nov 2026, 9:00 am", "+24h"],
  ["29 Nov 2026, 9:00 am", "+24h"],
  ["30 Nov 2026, 9:00 am", "+24h"],
];

export function SchedulesNewFigure() {
  return (
    <DialogFrame
      title={`New schedule for ${TASK}`}
      className="gap-0 p-0 max-w-3xl text-base"
      titleClassName="px-4"
    >
      <div className="mt-[1.0625rem]">
        <div className="flex max-h-[44rem] flex-col overflow-hidden">
          <div className="overflow-hidden grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_16rem]">
            <div className="p-4">
              <div className="flex flex-col gap-y-5">
                <div data-mark="generate" className="max-w-md">
                  <span className={label}>
                    <I.AISparkleIcon className="inline-block size-4" /> Describe your schedule using
                    natural language
                  </span>
                  <div
                    className="mt-1 rounded p-px"
                    style={{ background: "linear-gradient(to bottom right, #E543FF, #286399)" }}
                  >
                    <div className="overflow-hidden rounded-sm bg-background-bright">
                      {/* A rows=3 textarea: 76px, plus 7px of the line box under its baseline.
                            Its placeholder color comes from the stylesheet's preflight (gray-500). */}
                      <div className="m-0 min-h-10 h-[83px] w-full border-0 bg-background-bright px-3 py-2 text-sm text-gray-500">
                        e.g. the last Friday of the month at 6am
                      </div>
                      <div className="flex justify-end gap-2 px-2 pb-2">
                        <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 pl-1.5 pr-2.5 text-xs bg-tertiary">
                          <div className="relative flex w-full items-center">
                            <div className="justify-center flex w-full items-center text-text-bright gap-1.5">
                              <I.AISparkleIcon className="h-3.5 -mx-1 text-text-bright shrink-0 justify-start" />
                              <span className="mx-auto grow self-center truncate">Generate</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className={group}>
                  <span className={label}>
                    CRON pattern (UTC)
                    <div className="h-fit">
                      <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
                    </div>
                  </span>
                  <div data-mark="cron">
                    <Input value="0 9 * * *" />
                  </div>
                  <div className="font-sans text-sm font-medium text-text-dimmed">
                    <span className="mr-1">
                      <CheckIcon className="-mt-0.5 mr-1 inline-block h-4 w-4 text-success" />
                      <span className="text-success">Valid pattern:</span>
                    </span>
                    <span>At 09:00 AM.</span>
                  </div>
                </div>
                <div className={group}>
                  <span className={label}>Timezone</span>
                  {/* The select's hidden native control: 1px, but it adds a row to the grid. */}
                  <div className="h-px w-px" />
                  <div data-mark="timezone">
                    <Select className="text-text-bright">UTC</Select>
                  </div>
                  <div className={hint}>UTC will not change with daylight savings time.</div>
                </div>
                <div className={group}>
                  <Optional>Window</Optional>
                  <div data-mark="window">
                    <Input placeholder="30m or 25%" />
                  </div>
                  <div className={hint}>
                    Assigns each run a stable time after its CRON time, capped at the next CRON
                    occurrence. Use minutes, hours, or a percentage of the interval. Every schedule
                    gets at least a one-minute spread; enter <span className="font-mono">0m</span>{" "}
                    for that minimum.
                  </div>
                </div>
                <div className={group}>
                  <span className={label}>Environment</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <EnvCombo env="dev" />
                  </div>
                  <div className={hint}>
                    Note that scheduled tasks in dev environments will only run while you are
                    connected with the dev CLI.
                  </div>
                </div>
                <div className={group}>
                  <Optional>External ID</Optional>
                  <div data-mark="external-id">
                    <Input placeholder="Optionally specify your own ID, e.g. user id" />
                  </div>
                  <div className={hint}>
                    Optionally, you can specify your own IDs (like a user ID) and then use it inside
                    the run function of your task. This allows you to have per-user CRON tasks.{" "}
                    <span className="inline-text-link text-text-link inline-flex gap-0.5 items-center">
                      Read the docs.
                    </span>
                  </div>
                </div>
                <div className={group}>
                  <Optional>Deduplication key</Optional>
                  <Input />
                  <div className={hint}>
                    Optionally specify a key, you can only create one schedule with this key. This
                    is very useful when using the SDK and you don't want to create duplicate
                    schedules for a user.
                  </div>
                </div>
              </div>
            </div>
            <div className="sticky top-0 self-start border-l border-grid-dimmed p-4">
              <div data-mark="next-runs" data-mark-badge="left" className="flex flex-col gap-2">
                <div className="font-sans text-sm leading-5 font-semibold text-text-bright">
                  Next 5 runs
                </div>
                <div className="flex flex-col">
                  {nextRuns.map(([date, gap], index) => (
                    <div key={date} className="flex items-stretch gap-2.5">
                      <span className="flex w-2 flex-none flex-col items-center">
                        <span
                          className={`mt-1.5 size-2 flex-none rounded-full ${index === 0 ? "bg-schedules" : "bg-text-dimmed"}`}
                        />
                        {index < nextRuns.length - 1 ? (
                          <span className="w-px flex-1 bg-grid-bright" />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-col pb-3">
                        <span className="text-sm text-text-bright">{date}</span>
                        <span className="text-xs text-text-faint">{gap}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-grid-bright px-4 py-3">
            <div className="flex items-center gap-4">
              <Button>Cancel</Button>
            </div>
            <div className="flex items-center gap-4">
              <Button
                variant="primary"
                mark="create"
                markBadge="left"
                shortcut={
                  <>
                    <span>⌘</span>
                    <I.KeyboardEnterIcon className="w-2.5 h-4.5" />
                  </>
                }
              >
                Create schedule
              </Button>
            </div>
          </div>
        </div>
      </div>
    </DialogFrame>
  );
}

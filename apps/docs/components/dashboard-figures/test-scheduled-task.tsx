// A scheduled task's test page in Development: the schedule payload fields (Timestamp UTC, Last
// timestamp UTC, Timezone, External ID) above the run options, cut off where the page scrolls, with
// Templates and Recent runs at the top right. Drawn from the webapp source (no live tasks to copy);
// the date fields are copied from the dashboard's rendered DateField. The webapp files it mirrors
// are its `sources` in lib/dashboard-figures.ts.
import type { ReactNode } from "react";
import { Button, EnvCombo, PageHeader } from "./chrome";
import { Option } from "./form-parts";
import * as I from "./icons";
import { ScheduleClockIcon } from "./task-parts";

const hint = "font-sans text-xs font-medium text-text-dimmed";
const label =
  "font-sans text-[0.8125rem] font-normal text-text-bright leading-tight flex items-center gap-1";
const group = "grid w-full items-center gap-1.5 max-w-md";

/** DateField.tsx, variant small: one segment. Literals are dimmed. The hidden placeholder sizes the
 * segment as it does in the dashboard ("mm" is wider than two digits). */
function Segment({ children, ch, ph }: { children: ReactNode; ch?: string; ph?: string }) {
  return (
    <div
      className={`group box-content text-center tabular-nums h-5 text-xs rounded-sm px-0.5 ${ch ? "text-text-bright" : "text-text-faint"}`}
      style={ch ? { minWidth: ch } : undefined}
    >
      {ph && (
        <span
          className="flex h-full items-center justify-center text-center text-text-faint"
          style={{ visibility: "hidden", height: 0 }}
        >
          {ph}
        </span>
      )}
      <span className="flex h-full items-center justify-center">{children}</span>
    </div>
  );
}

function TertiaryButton({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 px-2.5 text-xs bg-tertiary">
      <div className="relative flex w-full items-center">
        <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
          <span className="mx-auto grow self-center truncate">{children}</span>
        </div>
      </div>
    </div>
  );
}

function DateField({ date, clear }: { date: [string, string, string]; clear?: boolean }) {
  const [y, m, d] = date;
  return (
    <div className="flex flex-col items-start">
      <div className="flex flex-row items-center gap-1">
        <div className="flex rounded-sm border bg-background-raised p-0.5">
          <Segment ch="4ch" ph="yyyy">
            {y}
          </Segment>
          <Segment>/</Segment>
          <Segment ch="2ch" ph="mm">
            {m}
          </Segment>
          <Segment>/</Segment>
          <Segment ch="2ch" ph="dd">
            {d}
          </Segment>
          <Segment>, </Segment>
          <Segment ch="2ch" ph="––">
            09
          </Segment>
          <Segment>:</Segment>
          <Segment ch="2ch" ph="––">
            00
          </Segment>
          <Segment>:</Segment>
          <Segment ch="2ch" ph="––">
            00
          </Segment>
          <Segment> </Segment>
          <Segment ch="2ch" ph="AM">
            AM
          </Segment>
        </div>
        <TertiaryButton>Now</TertiaryButton>
        {clear && <TertiaryButton>Clear</TertiaryButton>}
      </div>
    </div>
  );
}

export function TestScheduledTaskFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <PageHeader title="Test">
        <Button variant="docs" icon={I.BookIcon}>
          Test docs
        </Button>
      </PageHeader>
      <div className="grid min-h-0 grow grid-rows-[1fr_auto]">
        <div className="grid min-h-0 grid-cols-1 grid-rows-1 overflow-hidden">
          <div className="col-start-1 row-start-1 overflow-hidden">
            <div className="mx-auto w-fit p-3">
              <div className="mb-6 flex items-center gap-1.5">
                <ScheduleClockIcon className="size-4.5 min-w-4.5 text-schedules" />
                <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright">
                  first-scheduled-task
                </div>
              </div>
              <div className="flex flex-col gap-y-5">
                {/* Not in the dashboard's markup: groups the payload fields for one mark. Same gap. */}
                <div data-mark="payload" data-mark-badge="left" className="flex flex-col gap-y-5">
                  <div className={group}>
                    <div className={label}>Timestamp UTC</div>
                    <DateField date={["2026", "11", "25"]} />
                    <div className={hint}>
                      This is the timestamp of the CRON, it will come through to your run in the
                      payload.
                    </div>
                  </div>
                  <div className={group}>
                    <div className={label}>Last timestamp UTC</div>
                    <DateField date={["2026", "11", "24"]} clear />
                    <div className={hint}>
                      This is the timestamp of the previous run. You can use this in your code to
                      find new data since the previous run.
                    </div>
                  </div>
                  <Option
                    name="Timezone"
                    value="UTC"
                    help="The Timestamp and Last timestamp are in UTC so this just changes the timezone string that comes through in the payload."
                  />
                  <div className={group}>
                    <div className={label}>External ID</div>
                    <div className="flex items-center px-1 h-6 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg">
                      <div className="grow h-full w-full px-1 rounded text-xs leading-6 text-text-dimmed">
                        Optionally specify your own ID, e.g. user id
                      </div>
                    </div>
                    <div className={hint}>
                      Optionally, you can specify your own IDs (like a user ID) and then use it
                      inside the run function of your task.{" "}
                      <span className="text-text-link">Read the docs.</span>
                    </div>
                  </div>
                </div>
                <div className="w-full border-b border-grid-bright" />
                <div className={hint}>
                  Options enable you to control the execution behavior of your task.{" "}
                  <span className="text-text-link">Read the docs.</span>
                </div>
                <Option name="Machine" value="small-1x" help="Overrides the machine preset." />
                <Option
                  name="Version"
                  value="20261125.3 · Current"
                  disabled
                  help="In Development, runs use your newest version."
                />
                <Option
                  name="Region"
                  value="–"
                  disabled
                  help="Region is not available in the development environment."
                />
              </div>
            </div>
          </div>
          <div className="col-start-1 row-start-1 z-10 flex items-start justify-end p-2">
            <div className="flex items-center gap-1.5">
              <Button
                variant="tertiary"
                icon={I.StarSolidIcon}
                disabled
                mark="templates"
                markBadge="below"
              >
                Templates
              </Button>
              <Button
                variant="tertiary"
                icon={I.ClockRotateLeftIcon}
                mark="recent-runs"
                markBadge="below"
              >
                Recent runs
              </Button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-grid-bright bg-background-dimmed p-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="font-sans text-sm font-medium text-text-dimmed whitespace-nowrap">
                This test will run in
              </div>
              <EnvCombo env="dev" gap="gap-0.5" />
            </div>
            <Button variant="tertiary" size="medium" icon={I.StarSolidIcon} />
            <Button
              variant="primary"
              size="medium"
              icon={I.BeakerIcon}
              iconClassName="-mx-2"
              mark="run-test"
              markBadge="left"
              shortcut={
                <>
                  <span>⌘</span>
                  <I.KeyboardEnterIcon className="w-2.5 h-4.5" />
                </>
              }
            >
              Run test
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

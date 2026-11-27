// The Runs page (runs-list.tsx) with two runs selected and the Create a bulk action panel open on
// the right (runs bulkaction route, CreateBulkActionInspector), set to replay the selected runs.
// Drawn from source (the test dashboard had no runs, and the panel needs some); the webapp files it
// mirrors are its `sources` in lib/dashboard-figures.ts.
import { ChevronDown, Circle } from "lucide-react";
import type { ReactNode } from "react";
import { EnvCombo, ShortcutKey } from "./chrome";
import { Select } from "./form-parts";
import * as I from "./icons";
import { RunsHeader, RunsTable, RunsToolbar } from "./runs-list";

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const hint = "font-sans text-xs font-medium text-text-dimmed";
const inputGroup = "grid w-full items-center gap-1.5 max-w-md";

/** RadioGroupItem's circle: checked is indigo with a white dot. */
function RadioCircle({ checked }: { checked?: boolean }) {
  return (
    <div
      className={`aspect-square h-4 w-4 shrink-0 overflow-hidden rounded-full border mt-0 ${checked ? "border-indigo-500" : "border-border-bright"}`}
    >
      {checked && (
        <div className="flex h-full w-full items-center justify-center rounded-full bg-indigo-600">
          <Circle className="size-2 fill-white text-white dark:fill-text-bright dark:text-text-bright" />
        </div>
      )}
    </div>
  );
}

const checkedItem = "border-border-selected bg-surface-selected";
const uncheckedItem = "border-border-bright/50 bg-background-bright";

/** RadioGroupItem variant "button/small" (BulkActionModeField). */
function ModeItem({ checked, children }: { checked?: boolean; children: ReactNode }) {
  return (
    <div
      className={`group flex gap-x-2 items-center w-fit h-8 pl-2 pr-3 rounded-md border shadow-xs ${checked ? checkedItem : uncheckedItem}`}
    >
      <RadioCircle checked={checked} />
      <div>
        <div className="flex items-center gap-x-2">
          <span className="text-sm text-text-bright select-none">{children}</span>
        </div>
      </div>
    </div>
  );
}

/** RadioGroupItem variant "description" (Bulk action to perform). */
function ActionItem({
  checked,
  mark,
  title,
  description,
}: {
  checked?: boolean;
  mark?: string;
  title: ReactNode;
  description: string;
}) {
  return (
    <div
      data-mark={mark}
      className={`group flex items-start gap-x-2 w-full p-2.5 rounded-md border shadow-xs ${checked ? checkedItem : uncheckedItem}`}
    >
      <RadioCircle checked={checked} />
      <div>
        <div className="flex items-center gap-x-2">
          <span className="text-text-bright font-semibold -mt-0.5 text-left text-sm">{title}</span>
        </div>
        <div className="font-sans text-sm font-medium text-text-dimmed mt-0 text-left">
          {description}
        </div>
      </div>
    </div>
  );
}

function BulkActionPanel() {
  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <div className="font-sans text-base leading-6 font-semibold tracking-tight text-text-bright whitespace-nowrap">
          Create a bulk action
        </div>
        {/* minimal/small with no label, the esc key before the trailing icon, className pl-1. */}
        <div className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-6 pl-1 pr-2.5 text-xs bg-transparent">
          <div className="relative flex w-full items-center">
            <div className="justify-center flex w-full items-center text-text-dimmed gap-x-2.5">
              <ShortcutKey
                k={<span className="capitalize">Esc</span>}
                className="-ml-0.5 -mr-1.5 justify-self-center border-dimmed/40 text-text-dimmed"
              />
              <I.ExitIcon className="h-3.5 -mx-1 text-text-dimmed shrink-0 justify-end" />
            </div>
          </div>
        </div>
      </div>
      {/* overflow-y-scroll in the dashboard. */}
      <div className="overflow-hidden">
        <div className="px-3 pt-3">
          {/* The instructions accordion, closed (open by default only before the first bulk action). */}
          <div className="group rounded border border-grid-bright">
            <div className="flex">
              <div className="flex flex-1 items-center justify-between py-2 pl-2 pr-3 text-sm text-text-bright">
                <div className="flex items-center gap-1">
                  <I.InformationCircleIcon className="size-5 shrink-0 text-blue-500" />
                  <div className="pl-0.5">How to create a bulk action</div>
                </div>
                <ChevronDown className="h-4 w-4 shrink-0" />
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-y-5 p-3">
          <div className={inputGroup}>
            <div className={label}>Select</div>
            <div data-mark="select" className="flex flex-col items-start gap-2">
              <ModeItem>All ~7 runs matching your filters</ModeItem>
              <ModeItem checked>2 individually selected runs</ModeItem>
            </div>
          </div>
          <div className={inputGroup}>
            <div className={label}>Name</div>
            <div
              data-mark="name"
              className="flex items-center px-1 h-8 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg"
            >
              <span className="grow h-full w-full px-1.5 rounded text-sm leading-8 text-text-dimmed">
                A name for this bulk action
              </span>
            </div>
            <div className={hint}>Add a name to identify this bulk action (optional).</div>
          </div>
          <div className={inputGroup}>
            <div className={label}>Bulk action to perform</div>
            <div data-mark="action" className="flex flex-col items-start gap-2">
              <ActionItem
                title={
                  <span className="inline-flex items-center gap-1">
                    <I.XCircleIcon className="size-4 text-error" /> Cancel runs
                  </span>
                }
                description="Cancels all runs still in progress. Any finished runs won’t be canceled."
              />
              <ActionItem
                checked
                title={
                  <span className="inline-flex items-center gap-1">
                    <I.ArrowPathIcon className="size-4 text-blue-400" /> Replay runs
                  </span>
                }
                description="Replays all selected runs, regardless of current status."
              />
            </div>
          </div>
          <div className={inputGroup}>
            <div className={label}>Environment</div>
            <Select mark="environment">
              <EnvCombo env="dev" />
            </Select>
            <div className={hint}>Replay the runs into another environment of this project.</div>
          </div>
          <div className={inputGroup}>
            <div className={label}>Version</div>
            {/* Disabled in Development, which always uses the newest version. */}
            {/* The mark sits on a wrapper: the select's opacity-50 would dim the ring too. */}
            <div data-mark="version" className="rounded">
              <Select disabled>20261125.4 · Current</Select>
            </div>
            <div className={hint}>In Development, runs use your newest version.</div>
          </div>
          <div className={inputGroup}>
            <div className={label}>Preview</div>
            <div className="font-sans text-sm font-medium text-text-dimmed">
              You have individually selected 2 runs to be{" "}
              <span>
                <I.ArrowPathIcon className="mb-0.5 inline-block size-4 text-blue-400" />
                <span className="ml-0.5 text-text-bright">Replayed</span>
              </span>
              .
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 px-2 border-t border-grid-dimmed">
        {/* secondary/medium; the icon's size and colour replace the variant's (tailwind-merge). */}
        <div
          data-mark="confirm"
          data-mark-badge="left"
          className="flex w-fit font-normal text-center font-sans justify-center items-center shrink-0 rounded-[3px] h-8 px-3 text-sm bg-secondary border border-border-bright/50 shadow-xs"
        >
          <div className="relative flex w-full items-center">
            <div className="justify-center flex w-full items-center text-text-bright gap-x-2.5">
              <I.ArrowPathIcon className="-mx-1 w-[1.3rem] h-[1.3rem] text-blue-400 shrink-0 justify-start" />
              <span className="text-text-bright">Replay 2 runs…</span>
              <ShortcutKey
                size="medium"
                k={
                  <>
                    <span>⌘</span>
                    <I.KeyboardEnterIcon className="w-2.5 h-4.5" />
                  </>
                }
                className="-ml-0.5 -mr-1.5 rounded justify-self-center border-text-dimmed/40 text-text-dimmed"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const selected = ["p3s8wq2k", "t6c0vj4n"];

export function BulkActionCreateFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunsHeader />
      <div className="flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col">
          <RunsToolbar selected={selected.length} bulkHidden />
          <RunsTable selected={selected} />
        </div>
        {/* ResizableHandle: a 1px grid line centred in 3px, with its three grip dots. */}
        <div className="relative flex items-center justify-center w-0.75 before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright">
          <div className="relative z-1 flex h-5 w-0.75 flex-col items-center justify-center gap-0.75 bg-background-dimmed">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
            ))}
          </div>
        </div>
        <div className="w-[400px] shrink-0">
          <BulkActionPanel />
        </div>
      </div>
    </div>
  );
}

// The Replay this run dialog (ReplayRunDialog.tsx) for the Failed hello-world run in Development, at
// the dashboard's lg size (max-w-5xl, 85vh of a 900px window). Drawn from source (the test
// dashboard has no runs to replay); the webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts. The editor and the options are the Test page's (test-task.tsx).
import { ChevronDown } from "lucide-react";
import { Button, EnvCombo } from "./chrome";
import { DialogClose, Editor, Option, SmallInput, UnderlineTab } from "./form-parts";
import * as I from "./icons";

const hint = "font-sans text-xs font-medium text-text-dimmed";
const smallLabel =
  "font-sans text-[0.8125rem] font-normal text-text-bright leading-tight flex items-center gap-1";

export function ReplayRunFigure() {
  return (
    // text-base: the dialog sets no size and inherits the dashboard body's 16px.
    <div className="relative flex h-full flex-col gap-4 overflow-hidden rounded-lg border bg-background-dimmed pb-4 pt-2.5 text-base shadow-lg">
      {/* Dialog.tsx draws this divider with an <hr>. */}
      <div className="absolute left-0 top-11 h-px w-full bg-grid-bright" />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-col text-left font-medium text-text-bright px-3">
          Replay this run
        </div>
        <div className="flex flex-1 flex-col overflow-hidden px-3">
          <div className="font-sans text-base font-medium text-text-dimmed pt-6">
            Replaying will create a new run in the selected environment. You can modify the payload,
            metadata and run options.
          </div>
          {/* ResizablePanelGroup: the payload editor, the handle, the options panel (300px). */}
          <div className="-mx-3 mt-3 flex min-h-0 flex-1 border-b border-t border-grid-dimmed">
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="mb-3 h-full min-h-40 overflow-hidden rounded-sm bg-background-deep">
                <div className="grid h-full grid-rows-[2.5rem_1fr]">
                  <div className="mx-3 flex items-center justify-end gap-2 border-b border-grid-dimmed">
                    <div className="flex grow items-baseline justify-between self-end">
                      <div className="flex gap-5">
                        <div className="flex items-center gap-1.5">
                          <UnderlineTab active mark="payload">
                            Payload
                          </UnderlineTab>
                        </div>
                        <UnderlineTab>Metadata</UnderlineTab>
                      </div>
                    </div>
                    <Button variant="minimal" trailingIcon={I.TrashIcon}>
                      Clear
                    </Button>
                    <Button variant="minimal" trailingIcon={I.ClipboardSolidIcon}>
                      Copy
                    </Button>
                  </div>
                  <Editor />
                </div>
              </div>
            </div>
            {/* ResizableHandle: a 1px grid line centred in 3px, with its three grip dots. */}
            <div className="relative flex items-center justify-center w-0.75 before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright">
              <div className="relative z-1 flex h-5 w-0.75 flex-col items-center justify-center gap-0.75 bg-background-dimmed">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
                ))}
              </div>
            </div>
            {/* overflow-y-scroll in the dashboard: the options below Max attempts are cut off. */}
            <div className="w-[300px] shrink-0 overflow-hidden">
              <div className="flex flex-col gap-y-5 px-3 py-3">
                <div className={hint}>
                  Options enable you to control the execution behavior of your task.{" "}
                  <span className="text-text-link">Read the docs.</span>
                </div>
                <Option name="Machine" value="small-1x" help="Overrides the machine preset." />
                <Option
                  name="Version"
                  value="20261125.4 · Current"
                  disabled
                  help="In Development, runs use your newest version."
                />
                <Option
                  name="Region"
                  value="–"
                  disabled
                  help="Region is not available in the development environment."
                />
                <Option
                  name="Queue"
                  value="task/hello-world"
                  help="Assign run to a specific queue."
                />
                <div className="grid w-full items-center gap-1.5 max-w-md">
                  <div className={smallLabel}>Tags</div>
                  <div className="flex flex-col gap-2">
                    <SmallInput placeholder="Type and press Enter to add tags" />
                  </div>
                  <div className={hint}>Add tags to easily filter runs.</div>
                </div>
                <div className="grid w-full items-center gap-1.5 max-w-md">
                  <div className={smallLabel}>Max attempts</div>
                  <SmallInput value="3" />
                  <div className={hint}>
                    Retries failed runs up to the specified number of attempts.
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed pt-3.5">
            <Button variant="tertiary" size="medium">
              Cancel
            </Button>
            <div className="flex items-center gap-3">
              <div
                data-mark="environment"
                data-mark-badge="left"
                className="flex w-full items-center gap-3 max-w-md flex-row"
              >
                <div className="font-sans text-sm text-text-bright leading-tight flex items-center gap-1 whitespace-nowrap">
                  Replay this run in
                </div>
                {/* Select tertiary/medium, min-w-44, with dropdownIcon. */}
                <div className="group flex items-center gap-1 h-8 rounded px-3 text-sm bg-tertiary border border-tertiary min-w-44">
                  <div className="flex min-w-0 grow items-center gap-0.5 overflow-hidden">
                    <div className="min-w-0 truncate">
                      <div className="flex items-center pl-1 pr-2">
                        <EnvCombo env="dev" />
                      </div>
                    </div>
                  </div>
                  <ChevronDown className="size-4 flex-none text-text-dimmed" />
                </div>
              </div>
              <Button
                variant="primary"
                size="medium"
                mark="replay"
                markBadge="left"
                shortcut={
                  <>
                    <span>⌘</span>
                    <I.KeyboardEnterIcon className="w-2.5 h-4.5" />
                  </>
                }
              >
                Replay run
              </Button>
            </div>
          </div>
        </div>
      </div>
      <DialogClose />
    </div>
  );
}

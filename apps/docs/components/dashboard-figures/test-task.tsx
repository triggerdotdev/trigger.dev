// A task's test page, for a standard task in Development. The side menu is cropped off: the page
// is reached from the task, not the menu. Drawn from the webapp source (no live tasks to copy);
// the files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { Button, EnvCombo, PageHeader } from "./chrome";
import { Editor, Option, UnderlineTab } from "./form-parts";
import * as I from "./icons";

const hint = "font-sans text-xs font-medium text-text-dimmed";

export function TestTaskFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <PageHeader title="Test">
        <Button variant="docs" icon={I.BookIcon}>
          Test docs
        </Button>
      </PageHeader>
      <div className="flex min-h-0 grow flex-col">
        <div className="flex items-center justify-between gap-1.5 border-b border-grid-bright p-2">
          <div className="flex items-center gap-1.5">
            <I.TaskSmallIcon className="size-4.5 min-w-4.5 text-tasks" />
            <div className="font-sans text-xs font-medium text-text-dimmed">hello-world</div>
          </div>
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
        <div className="grid min-h-0 grow grid-cols-[1fr_3px_380px]">
          <div className="flex h-full flex-col overflow-hidden bg-background-deep">
            <div className="grid grid-rows-[2.5rem_1fr]">
              <div className="mx-3 flex items-center justify-end gap-2 border-b border-grid-dimmed">
                <div className="flex grow items-baseline justify-between self-end">
                  <div className="flex gap-5">
                    <UnderlineTab active mark="payload">
                      Payload
                    </UnderlineTab>
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
          <div className="relative before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright" />
          <div className="flex h-full min-h-0 flex-col overflow-hidden pt-1">
            <div className="mx-3 flex shrink-0 gap-x-6 border-b border-grid-bright">
              <UnderlineTab active mark="options">
                Options
              </UnderlineTab>
              <UnderlineTab>
                <span className="flex items-center gap-0.5">
                  <I.AISparkleIcon className="size-4" /> AI
                </span>
              </UnderlineTab>
              <UnderlineTab>Schema</UnderlineTab>
            </div>
            <div className="flex flex-col gap-y-5 px-3 py-3">
              <div className={hint}>
                Options enable you to control the execution behavior of your task.{" "}
                <span className="text-text-link">Read the docs.</span>
              </div>
              <Option name="Machine" value="small-1x" help="Overrides the machine preset." />
              <Option
                name="Version"
                value="20261125.1 · Current"
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

// The New environment variables dialog. Copied from the rendered dashboard; the webapp files it
// mirrors are its `sources` in lib/dashboard-figures.ts.
import { XMarkIcon } from "@heroicons/react/20/solid";
import { Button, envs, type Env } from "./chrome";
import { CheckboxBox, DialogFrame, FormButtons, Switch } from "./form-parts";
import * as I from "./icons";

const variables = [
  { key: "DATABASE_URL", value: "postgresql://localhost:5432/acme" },
  { key: "STRIPE_SECRET_KEY", value: "sk_test_example" },
  { key: "APP_URL", value: "https://example.com" },
];

function EnvironmentChoice({ env, checked }: { env: Env; checked?: boolean }) {
  return (
    <span
      className={`group flex items-start gap-x-2 w-fit py-2 pl-3 pr-4 rounded border ${checked ? "bg-background-dimmed border-grid-dimmed" : "border-border-bright"}`}
    >
      <CheckboxBox checked={checked} />
      <div>
        <div className="flex items-center gap-x-2">
          <span className="text-text-bright">
            <span className={`truncate text-left ${envs[env].text} text-sm`}>{envs[env].full}</span>
          </span>
        </div>
      </div>
    </span>
  );
}

const label = "font-sans text-sm text-text-bright leading-tight flex items-center gap-1";
const hint = "font-sans text-xs font-medium text-text-dimmed";
const input =
  "flex items-center px-1 h-8 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full";
const inputText = "grow h-full w-full px-2 text-sm leading-8 text-text-bright truncate";

export function EnvironmentVariablesNewFigure() {
  return (
    <DialogFrame
      title="New environment variables"
      className="gap-4 p-0 max-w-3xl"
      titleClassName="px-4"
    >
      <div>
        <div className="flex flex-col gap-y-5 p-4">
          <div className="grid items-center gap-1.5 w-full">
            <span className={label}>Environments</span>
            <div data-mark="environments" className="flex items-center gap-2 w-fit">
              <EnvironmentChoice env="dev" checked />
              <EnvironmentChoice env="staging" />
              <EnvironmentChoice env="preview" />
              <EnvironmentChoice env="prod" checked />
            </div>
            <div className={hint}>
              Dev environment variables specified here will be overridden by ones in your .env file
              when running locally.
            </div>
          </div>
          <div className="grid items-center gap-1.5 max-w-md w-auto">
            <div className="group items-center gap-x-2 rounded-md py-1.5 px-2 -ml-2 inline-flex w-fit">
              <span className="whitespace-nowrap text-sm text-text-dimmed">
                <span className="text-text-bright">Secret value</span>
              </span>
              <Switch size="medium" />
            </div>
            <div className={`${hint} -mt-1`}>
              If enabled, you and your team will not be able to view the values after creation.
            </div>
          </div>
          <div className="grid items-center gap-1.5 w-full">
            <div className="grid w-full grid-cols-[1fr_1fr] gap-1.5">
              <span className={label}>Key</span>
              <div className="flex justify-between gap-1">
                <span className={label}>Value</span>
                <div className="group flex items-center h-6 gap-x-1.5 rounded pr-1 py-[0.1rem] pl-1.5 text-text-dimmed">
                  <span className="whitespace-nowrap text-xs text-text-dimmed">Reveal</span>
                  <Switch size="small" checked />
                </div>
              </div>
            </div>
            {variables.map((v) => (
              <div key={v.key} className="grid w-full grid-cols-[1fr_1fr] gap-1.5">
                <div className="space-y-2">
                  <div className={input}>
                    <div className={inputText}>{v.key}</div>
                  </div>
                </div>
                <div className="flex items-start gap-1">
                  <div className="grow space-y-2">
                    <div className={input}>
                      <div className={inputText}>{v.value}</div>
                    </div>
                  </div>
                  <Button variant="minimal" size="medium" icon={XMarkIcon} />
                </div>
              </div>
            ))}
            {/* The dashboard lays out the hidden Agent Vault domain field in the same cell, so the row is its height. */}
            <div className="grid">
              <div className="col-start-1 row-start-1 flex items-start justify-between gap-4">
                <div className={`${hint} pt-2`}>
                  Tip: Paste all your .env values at once into this form to populate it.
                </div>
                <Button
                  variant="tertiary"
                  size="medium"
                  icon={I.PlusIcon}
                  mark="add-another"
                  markBadge="below"
                >
                  Add another
                </Button>
              </div>
              <div aria-hidden className="invisible col-start-1 row-start-1 grid gap-1">
                <span className={label}>Allowed domains</span>
                <div className="min-h-9 rounded border border-border-bright/50 p-1">
                  <div className="h-7" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <FormButtons
          className="px-4 pb-4"
          cancel={
            <Button variant="tertiary" size="medium">
              Cancel
            </Button>
          }
          confirm={
            <div className="flex flex-row-reverse items-center gap-2">
              <Button variant="primary" size="medium" mark="save" markBadge="below">
                Save
              </Button>
              <Button size="medium">Override</Button>
            </div>
          }
        />
      </div>
    </DialogFrame>
  );
}

// The Create override dialog on a prompt's page, for the customer-support prompt from the Prompts
// docs: its template in the editor with the last line edited, and the Override settings sidebar
// with a commit message, the model and the variables from code. Drawn from source (the reference
// dashboard has no prompts); the dialog fills the canvas, as the New API key figure's does. The
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { ClipboardIcon } from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import { Button } from "./chrome";
import { DialogClose } from "./form-parts";
import { ResizableHandle } from "./detail-parts";

// The customer-support prompt's template, with its last line edited.
const template = [
  "You are a support agent for Acme SaaS.",
  "",
  "## Customer context",
  "",
  "- **Name:** {{customerName}}",
  "- **Plan:** {{plan}}",
  "- **Issue:** {{issue}}",
  "",
  "Respond to the customer's issue in two sentences or fewer.",
];

/** TextEditor: the Copy toolbar, then CodeMirror with 40px line numbers and no language. */
function TemplateEditor() {
  return (
    <div className="grid h-full grid-rows-[2.5rem_1fr]">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <div className="flex items-center" />
        <div className="flex items-center gap-2">
          <Button variant="minimal" trailingIcon={ClipboardIcon}>
            Copy
          </Button>
        </div>
      </div>
      <div className="min-h-0 min-w-0 overflow-hidden">
        <div className="flex font-mono text-[14px] leading-[1.4] text-editor-foreground">
          <div className="shrink-0 py-1 text-editor-comment" style={{ minWidth: 40 }}>
            {template.map((_, i) => (
              <div key={i} className="pl-[5px] pr-[3px] text-right">
                {i + 1}
              </div>
            ))}
          </div>
          {/* The mark wraps the text only, so its badge sits beside the longest line. */}
          <div data-mark="template" className="w-fit py-1">
            {template.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap pl-1.5 pr-0.5">
                {line || " "}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const labelSmall =
  "font-sans text-[0.8125rem] font-normal text-text-bright leading-tight flex items-center gap-1";

function Group({ mark, children }: { mark?: string; children: ReactNode }) {
  return (
    <div
      data-mark={mark}
      data-mark-badge="left"
      className="grid w-full items-center gap-1.5 max-w-md"
    >
      {children}
    </div>
  );
}

/** Input, "small" variant, with a value. Its text sits 1px higher than form-parts' SmallInput,
 * as the dashboard's sidebar draws it. */
function SmallInput({ value }: { value: string }) {
  return (
    <div className="flex items-center px-1 h-6 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg">
      <div className="grow px-1 rounded text-xs text-text-bright truncate">{value}</div>
    </div>
  );
}

const variables = ["customerName", "plan", "issue"];

export function PromptOverrideFigure() {
  return (
    <div className="h-full bg-background-dimmed">
      {/* DialogContent with OverrideDialog's classes: a flex column, no left padding. */}
      <div className="relative flex h-full w-full flex-col gap-0 overflow-hidden rounded-lg border bg-background-dimmed pb-4 pl-0 pr-3 pt-0 shadow-lg">
        <div className="flex flex-col px-4 py-2.5 text-left font-medium text-text-bright">
          Create override
        </div>
        <div className="-mx-3 flex min-h-0 w-auto flex-1 border-b border-t border-grid-dimmed">
          <div className="min-w-0 flex-1 bg-[#121317] light:bg-editor-background">
            <TemplateEditor />
          </div>
          <ResizableHandle />
          <div className="shrink-0" style={{ width: 280 }}>
            <div className="h-full px-3 py-3">
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="font-sans text-sm leading-5 font-semibold text-text-bright">
                    Override settings
                  </div>
                  <Group mark="commit-message">
                    <span className={labelSmall}>Commit message</span>
                    <SmallInput value="Shorter replies" />
                  </Group>
                  <Group mark="model">
                    <span className={labelSmall}>Model</span>
                    <SmallInput value="gpt-6-luna" />
                    <div className="font-sans text-xs font-medium text-text-dimmed">
                      Override the default model for this version
                    </div>
                  </Group>
                </div>
                <div className="space-y-1.5 border-t border-grid-dimmed pt-3">
                  <span className={labelSmall}>Variables (from code)</span>
                  <div className="space-y-1">
                    {variables.map((v) => (
                      <div key={v} className="flex items-center gap-1.5 text-xs">
                        <span className="font-mono rounded bg-background-hover px-1 py-0.5 text-text-bright">
                          {v}
                        </span>
                        <span className="text-text-dimmed">string</span>
                        {/* Badge "extra-small" with the amber override classes. */}
                        <div className="grid place-items-center border rounded-sm px-1 h-4 text-xxs bg-background-bright whitespace-nowrap border-amber-500/30 text-amber-400">
                          required
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 pl-4 pr-1 pt-3">
          <Button size="medium">Cancel</Button>
          <Button variant="primary" size="medium" mark="create" markBadge="left">
            Create override
          </Button>
        </div>
        <DialogClose />
      </div>
    </div>
  );
}

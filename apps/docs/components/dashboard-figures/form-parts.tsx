// Dialogs and form controls shared by the figures, as static frames of the webapp primitives
// (primitives/Dialog.tsx, FormButtons.tsx, Select.tsx, Switch.tsx, Input.tsx,
// SegmentedControl.tsx). Each figure lists the primitives it draws in its `sources`.
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import * as I from "./icons";

// ---- Dialog (primitives/Dialog.tsx) ----

/** DialogContent's close button, top right. */
export function DialogClose() {
  return (
    <div className="flex size-7 items-center justify-center rounded-sm opacity-70 absolute right-2 top-2.25">
      <I.CloseIcon className="size-4 text-text-dimmed" />
    </div>
  );
}

/**
 * A dialog centered on the dimmed page: DialogContent, the divider under the header, the title,
 * the close button. `className` is the dialog's own padding, gap and width.
 */
export function DialogFrame({
  title,
  className = "gap-4 px-4 pb-4 max-w-lg",
  titleClassName = "",
  children,
}: {
  title: ReactNode;
  className?: string;
  titleClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center bg-background-dimmed">
      <div
        className={`relative grid border bg-background-dimmed shadow-lg w-full rounded-lg pt-2.5 ${className}`}
      >
        {/* Dialog.tsx draws this divider with an <hr>: a div keeps the figure free of semantic tags. */}
        <div className="absolute left-0 top-11 h-px w-full bg-grid-bright" />
        <div className={`flex flex-col text-left font-medium text-text-bright ${titleClassName}`}>
          {title}
        </div>
        {children}
        <DialogClose />
      </div>
    </div>
  );
}

/** FormButtons: cancel on the left (or nothing), confirm on the right, above a divider. */
export function FormButtons({
  cancel,
  confirm,
  className = "",
}: {
  cancel?: ReactNode;
  confirm: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex w-full items-center justify-between border-t border-grid-bright pt-4 ${className}`}
    >
      {cancel ?? <div />}
      {confirm}
    </div>
  );
}

// ---- Controls ----

/** A native checkbox as the dashboard styles it (checked: indigo with the forms plugin's check). */
export function CheckboxBox({ checked }: { checked?: boolean }) {
  return checked ? (
    <div className="mt-1 grid size-4 place-items-center rounded-sm border border-transparent bg-indigo-500">
      <svg viewBox="0 0 16 16" fill="white" className="size-4">
        <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
      </svg>
    </div>
  ) : (
    <div className="mt-1 size-4 rounded-sm border border-border-bright bg-transparent" />
  );
}

const selectVariants = {
  "tertiary/small": "h-6 rounded text-xs px-2 bg-tertiary border border-tertiary",
  "tertiary/medium": "h-8 rounded px-3 text-sm bg-tertiary border border-tertiary",
  "secondary/medium":
    "h-8 rounded px-3 text-sm bg-secondary border border-border-bright/50 shadow-xs",
};

/** A closed Select: the value (or placeholder) and the chevron. `className` sets the text color. */
export function Select({
  variant = "tertiary/medium",
  className = "",
  mark,
  disabled,
  children,
}: {
  variant?: keyof typeof selectVariants;
  className?: string;
  mark?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-mark={mark}
      className={`group flex items-center gap-1 ${selectVariants[variant]} ${className} ${disabled ? "opacity-50" : ""}`}
    >
      <div className="flex min-w-0 grow items-center gap-0.5 overflow-hidden">
        <div className="min-w-0 truncate">{children}</div>
      </div>
      <ChevronDown className="size-4 flex-none text-text-dimmed" />
    </div>
  );
}

/** Switch's track and thumb ("small" or "medium" variant). */
export function Switch({ size, checked }: { size: "small" | "medium"; checked?: boolean }) {
  const track = size === "small" ? "h-3 w-5.5" : "h-4 w-7.5";
  const thumb = size === "small" ? "h-2.5 w-2.5" : "h-3 w-3";
  const on = size === "small" ? "translate-x-2" : "translate-x-3.5";
  return (
    <div
      className={`inline-flex shrink-0 items-center rounded-full border-2 border-transparent ${checked ? "bg-accent-fill" : "bg-background-raised"} ${track}`}
    >
      <span
        className={`${thumb} ${checked ? `${on} bg-white` : "translate-x-0 bg-white dark:bg-charcoal-200"} block rounded-full`}
      />
    </div>
  );
}

/** Input, "medium" variant, with a value or its placeholder. */
export function Input({ value, placeholder }: { value?: string; placeholder?: string }) {
  return (
    <div className="flex items-center ring-offset-background px-1 h-8 rounded border border-border-bright/50 shadow-xs bg-input-bg w-full">
      <div
        className={`grow h-full w-full bg-transparent px-1.5 rounded text-sm leading-8 truncate ${value ? "text-text-bright" : "text-text-dimmed"}`}
      >
        {value ?? placeholder}
      </div>
    </div>
  );
}

/** Input, "small" variant, with a value or its placeholder. */
export function SmallInput({
  value,
  placeholder,
  mono,
}: {
  value?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center px-1 h-6 w-full rounded border border-border-bright/50 shadow-xs bg-input-bg">
      <span
        className={`grow h-full w-full px-1 rounded text-xs leading-6 ${mono ? "font-mono " : ""}${value ? "text-text-bright" : "text-text-dimmed"}`}
      >
        {value ?? placeholder}
      </span>
    </div>
  );
}

/** One option of a SegmentedControl ("small" or "medium"); the selected one has the raised pill. */
export function Segment({
  size,
  selected,
  disabled,
  mark,
  children,
}: {
  size: "small" | "medium";
  selected?: boolean;
  disabled?: boolean;
  mark?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-mark={mark}
      data-mark-badge={mark ? "below" : undefined}
      className={`relative flex h-full grow text-center font-normal ${selected ? "text-text-bright" : "text-text-dimmed"} ${disabled ? "opacity-50" : ""}`}
    >
      <div
        className={`relative flex h-full w-full items-center justify-between ${size === "small" ? "px-2 text-xs" : "px-3 py-[0.13rem] text-sm"}`}
      >
        <div className="z-10 flex h-full w-full items-center justify-center">{children}</div>
        {selected && (
          <div className="absolute inset-0 rounded bg-white border border-grid-bright dark:bg-background-raised dark:border-border-bright" />
        )}
      </div>
    </div>
  );
}

// ---- Test page parts (the test-task figures and the dialogs that reuse them) ----

const optionHint = "font-sans text-xs font-medium text-text-dimmed";
const optionLabel =
  "font-sans text-[0.8125rem] font-normal text-text-bright leading-tight flex items-center gap-1";

/** Tabs.tsx TabButton and ClientTabs.tsx underline trigger: label over a 2px bar. */
export function UnderlineTab({
  active,
  mark,
  children,
}: {
  active?: boolean;
  mark?: string;
  children: ReactNode;
}) {
  return (
    <div data-mark={mark} data-mark-badge="below" className="flex flex-col items-center pt-1">
      <div className="flex items-center gap-1">
        <span className={`text-sm ${active ? "text-text-bright" : "text-text-dimmed"}`}>
          {children}
        </span>
      </div>
      <div className={`mt-1 h-0.5 w-full ${active ? "bg-indigo-500" : ""}`} />
    </div>
  );
}

export function Option({
  name,
  value,
  disabled,
  help,
}: {
  name: string;
  value: string;
  disabled?: boolean;
  help: string;
}) {
  return (
    <div className="grid items-center gap-1.5 max-w-md w-full">
      <div className={optionLabel}>{name}</div>
      <Select variant="tertiary/small" className="text-text-bright" disabled={disabled}>
        {value}
      </Select>
      <div className={optionHint}>{help}</div>
    </div>
  );
}

/** The payload as CodeMirror draws it: line numbers, fold gutter, JSON tokens. */
export function Editor() {
  const lines: ReactNode[] = [
    <span key="1">{"{"}</span>,
    <span key="2">
      {"  "}
      <span className="text-editor-name">"name"</span>:{" "}
      <span className="text-editor-string">"Acme"</span>
    </span>,
    <span key="3">{"}"}</span>,
  ];
  return (
    <div className="flex bg-editor-background font-mono text-[14px] leading-[1.4] text-editor-foreground">
      <div className="flex shrink-0 py-1 text-editor-comment">
        <div>
          {lines.map((_, i) => (
            <div key={i} className="min-w-5 pl-[5px] pr-[3px] text-right">
              {i + 1}
            </div>
          ))}
        </div>
        <div className="w-4">
          <div className="grid h-[1.4em] place-items-center">
            <ChevronDown className="size-3" />
          </div>
        </div>
      </div>
      <div className="grow py-1">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre pl-1.5 pr-0.5">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

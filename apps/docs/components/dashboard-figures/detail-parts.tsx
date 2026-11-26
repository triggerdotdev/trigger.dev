// The detail-page parts shared by the figures with a property rail: the page tabs, the rail's
// property groups (primitives/detail/DetailPage.tsx PropertyGroup and DetailProperty), CopyableText
// and the ResizableHandle between the main column and the rail.
import type { ReactNode } from "react";

export function Tab({
  label,
  count,
  selected,
  mark,
}: {
  label: string;
  count?: string;
  selected?: boolean;
  mark?: string;
}) {
  return (
    <div
      data-mark={mark}
      data-mark-badge={mark ? "below" : undefined}
      className="group/tab flex flex-col items-center h-full flex-none whitespace-nowrap"
    >
      <div className="flex items-center gap-1 flex-1">
        <span
          className={`font-sans text-sm font-normal leading-5 ${selected ? "text-text-bright" : "text-text-dimmed"}`}
        >
          {label}
          {count !== undefined && (
            <span className="ml-1.5 text-[0.6875rem] tabular-nums text-text-faint">{count}</span>
          )}
        </span>
      </div>
      <div
        className={
          selected
            ? "h-0.5 w-full bg-indigo-500"
            : "h-0.5 w-full bg-surface-control-active opacity-0"
        }
      />
    </div>
  );
}

export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0 text-sm min-w-0">
      <div className="font-medium text-text-bright">{label}</div>
      <div className="text-text-dimmed flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col px-4 pb-1.5 pt-3">
      <div className="mb-[9px] text-[0.6875rem] font-medium uppercase tracking-[0.07em] text-text-faint">
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/**
 * CopyableText; the copy button only shows on hover. Mono by default; `truncate` is the variant
 * that shrinks in a narrow column and keeps room for the button.
 */
export function Copyable({
  value,
  mono = true,
  truncate,
}: {
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <span
      className={`group relative inline-flex h-6 items-center${truncate ? " max-w-full pr-7 min-w-0" : ""}${mono ? " font-mono text-xs" : ""}`}
    >
      <span className={truncate ? "min-w-0 truncate" : mono ? "truncate" : undefined}>{value}</span>
    </span>
  );
}

/** ResizableHandle between the main column and the rail. */
export function ResizableHandle() {
  return (
    <div className="relative flex items-center justify-center w-0.75 before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright">
      <div className="relative z-1 flex h-5 w-0.75 flex-col items-center justify-center gap-0.75 bg-background-dimmed">
        <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
        <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
        <div className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control" />
      </div>
    </div>
  );
}

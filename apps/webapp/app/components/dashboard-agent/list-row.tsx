/**
 * The panel's shared list view: a selectable row with an optional hover action,
 * used by both suggested prompts and chat history.
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "~/utils/cn";

/** The list wrapper. Rows are `<li>`, so the list itself is an `<ol>`. */
export function AgentList({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn("flex w-full flex-col gap-1.5", className)}>{children}</ol>;
}

/** `promoted` is the product-chosen prompt; `selected` is the open chat. */
export type AgentListRowVariant = "default" | "promoted" | "selected";

const ROW_VARIANTS: Record<AgentListRowVariant, string> = {
  default:
    "border-grid-bright bg-background-bright/40 text-text-dimmed hover:border-border-bright hover:text-text-bright",
  promoted: "border-indigo-500/40 bg-indigo-500/5 text-text-bright hover:border-indigo-500/60",
  selected: "border-border-bright bg-background-bright text-text-bright",
};

export function AgentListRow({
  label,
  meta,
  status,
  variant = "default",
  unread = false,
  onSelect,
  action,
}: {
  /** The row's main text. Truncated to one line so every row is the same height. */
  label: ReactNode;
  /** Small right-aligned detail, e.g. when a chat was last active. */
  meta?: ReactNode;
  /** Trailing icon for something ongoing. Sits before {@link meta}, inside the button. */
  status?: ReactNode;
  variant?: AgentListRowVariant;
  /** Something happened here the user hasn't seen: bright label plus a dot. */
  unread?: boolean;
  onSelect: () => void;
  /** Hover-revealed control. Use {@link AgentListRowAction}. */
  action?: ReactNode;
}) {
  return (
    <li className="group flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm outline-hidden transition focus-custom",
          ROW_VARIANTS[variant],
          unread && "text-text-bright"
        )}
      >
        {status ? (
          <span className="flex w-4 shrink-0 items-center justify-center">{status}</span>
        ) : null}
        {unread ? (
          <>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-indigo-500" />
            <span className="sr-only">Unread.</span>
          </>
        ) : null}
        <span className="line-clamp-1 min-w-0 flex-1">{label}</span>
        {meta ? <span className="shrink-0 text-xs text-text-faint">{meta}</span> : null}
      </button>
      {action}
    </li>
  );
}

/** The hover-revealed icon button on the right of a row. */
export function AgentListRowAction({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ComponentType<{ className?: string }>;
  /** Accessible name: the control is icon-only. */
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded p-1 text-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-custom",
        danger ? "hover:text-error" : "hover:text-text-bright"
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

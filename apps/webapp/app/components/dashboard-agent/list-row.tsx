/**
 * The panel's shared list view.
 *
 * Both lists in the panel — suggested prompts and chat history — are the same
 * thing: a selectable row with an optional hover action. Keeping the row and
 * list styling here is what makes the panel read as one system instead of two
 * lists that drifted apart.
 *
 * The row is dashed, mono and slightly darker than the panel — the same language
 * the transcript's tool pills use, so a list reads as a record of things rather
 * than as a stack of buttons.
 */
import { ChevronRightIcon } from "@heroicons/react/20/solid";
import type { ComponentType, ReactNode } from "react";
import { cn } from "~/utils/cn";

/** The list wrapper. Rows are `<li>`, so the list itself is an `<ol>`. */
export function AgentList({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn("flex w-full flex-col gap-1.5", className)}>{children}</ol>;
}

/**
 * - `default` — a plain row.
 * - `promoted` — the product-chosen prompt.
 * - `selected` — the row the panel is currently showing (the open chat).
 */
export type AgentListRowVariant = "default" | "promoted" | "selected";

const ROW_VARIANTS: Record<AgentListRowVariant, string> = {
  default:
    "border-grid-bright bg-background-dimmed/60 text-text-dimmed hover:bg-background-hover hover:text-text-bright",
  promoted: "border-indigo-500/40 bg-indigo-500/10 text-text-bright hover:bg-indigo-500/20",
  selected: "border-border-bright bg-background-hover text-text-bright",
};

/**
 * - `row` — a full-width row in a stack: dashed, rounded, one line high.
 * - `pill` — the same row, fully rounded, for a list that reads as chips.
 */
export type AgentListRowShape = "row" | "pill";

const ROW_SHAPES: Record<AgentListRowShape, string> = {
  row: "rounded-lg",
  pill: "rounded-full",
};

/**
 * Mono, lightly tracked: the panel's lists name things (a chat, a question the
 * agent can answer) rather than speak, so they are set like labels, not prose.
 */
const ROW_TYPE = "font-mono text-xs tracking-wide";

export function AgentListRow({
  label,
  meta,
  status,
  icon: Icon,
  chevron = false,
  variant = "default",
  shape = "row",
  unread = false,
  onSelect,
  action,
}: {
  /** The row's main text. Truncated to one line so every row is the same height. */
  label: ReactNode;
  /** Small right-aligned detail, e.g. when a chat was last active. */
  meta?: ReactNode;
  /**
   * Trailing icon for something ongoing in this row, e.g. a chat the agent is
   * still working in. Sits before {@link meta}, inside the row's own button.
   */
  status?: ReactNode;
  /** Leading icon for what kind of row this is, e.g. a prompt's `</>`. */
  icon?: ComponentType<{ className?: string }>;
  /** Trailing chevron, for a row that reads as "go on then". */
  chevron?: boolean;
  variant?: AgentListRowVariant;
  shape?: AgentListRowShape;
  /**
   * Something happened here the user hasn't seen. Brightens the label and adds
   * the same indigo dot the launcher uses, so the two read as one signal.
   */
  unread?: boolean;
  onSelect: () => void;
  /** Hover-revealed control, e.g. dismiss or delete. Use {@link AgentListRowAction}. */
  action?: ReactNode;
}) {
  return (
    <li className="group flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 border border-dashed px-3 py-2 text-left outline-hidden transition focus-custom",
          ROW_TYPE,
          ROW_SHAPES[shape],
          ROW_VARIANTS[variant],
          unread && "text-text-bright"
        )}
      >
        {status ? (
          <span className="flex w-4 shrink-0 items-center justify-center">{status}</span>
        ) : null}
        {Icon ? <Icon className="size-3.5 shrink-0 text-text-faint" /> : null}
        {unread ? (
          <>
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-indigo-500" />
            <span className="sr-only">Unread.</span>
          </>
        ) : null}
        <span className="line-clamp-1 min-w-0 flex-1">{label}</span>
        {meta ? <span className="shrink-0 text-text-faint">{meta}</span> : null}
        {chevron ? (
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-text-faint" />
        ) : null}
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
  /** Accessible name — the control is icon-only. */
  label: string;
  onClick: () => void;
  /** Destructive actions go red on hover. */
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

import type { ComponentType, ReactNode } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";

// Rows are `<li>`, so the wrapper must stay a list element.
export function AgentList({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn("flex w-full flex-col gap-0.5", className)}>{children}</ol>;
}

export type AgentListRowVariant = "default" | "selected";

/** A minimal menu row, as in the side menu: no box until hovered, an action inside its right end. */
export function AgentListRow({
  label,
  meta,
  variant = "default",
  unread = false,
  onSelect,
  action,
}: {
  label: ReactNode;
  meta?: ReactNode;
  variant?: AgentListRowVariant;
  unread?: boolean;
  onSelect: () => void;
  /** Use {@link AgentListRowAction}. */
  action?: ReactNode;
}) {
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded px-2 text-left text-sm outline-hidden transition focus-custom",
          // Text alone says unread (bright) or read (dimmed), the selected row included: its fill is
          // what marks it. Hover is keyed to the whole row, so it holds while on the action.
          unread ? "text-text-bright" : "text-text-dimmed group-hover/row:text-text-bright",
          variant === "selected"
            ? "bg-background-hover group-hover/row:bg-surface-control/50"
            : "group-hover/row:bg-background-hover"
        )}
      >
        {/* Unread shows as a bright label, sorted to the top; this says it to a screen reader. */}
        {unread ? <span className="sr-only">Unread.</span> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {meta || action ? (
          // At least the action's width, so the action covers this slot and never the label.
          // It takes the slot's place while the row is hovered or focused from the keyboard.
          <span
            className={cn(
              "min-w-6 shrink-0 text-right text-xs text-text-faint",
              action && "group-has-[:focus-visible]/row:invisible group-hover/row:invisible"
            )}
          >
            {meta}
          </span>
        ) : null}
      </button>
      {action ? (
        // `:focus-visible`, not `:focus-within`: a popover focuses its first row as it opens,
        // and a mouse user who hasn't reached that row shouldn't see its action yet.
        <div className="pointer-events-none absolute bottom-1 right-1 top-1 flex aspect-square opacity-0 group-has-[:focus-visible]/row:pointer-events-auto group-has-[:focus-visible]/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
          {action}
        </div>
      ) : null}
    </li>
  );
}

/** The side menu's internal button: square, filling the row's inset, a fill only on its own hover. */
export function AgentListRowAction({
  icon: Icon,
  label,
  tooltip,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  /** The accessible name, specific to the row. */
  label: string;
  tooltip: string;
  onClick: () => void;
}) {
  return (
    <SimpleTooltip
      asChild
      tabbable
      disableHoverableContent
      delayDuration={500}
      content={tooltip}
      button={
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex size-full cursor-pointer items-center justify-center rounded text-text-dimmed transition focus-custom hover:bg-surface-control hover:text-text-bright"
        >
          <Icon className="size-4" />
        </button>
      }
    />
  );
}

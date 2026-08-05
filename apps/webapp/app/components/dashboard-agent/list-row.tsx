import type { ComponentType, ReactNode } from "react";
import { cn } from "~/utils/cn";

// Rows are `<li>`, so the wrapper must stay a list element.
export function AgentList({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cn("flex w-full flex-col gap-1.5", className)}>{children}</ol>;
}

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
  label: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  variant?: AgentListRowVariant;
  unread?: boolean;
  onSelect: () => void;
  /** Use {@link AgentListRowAction}. */
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

export function AgentListRowAction({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ComponentType<{ className?: string }>;
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

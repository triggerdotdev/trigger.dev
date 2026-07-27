import { ClockIcon, PencilSquareIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";

export function DashboardAgentHeader({
  view,
  title,
  onNewChat,
  onToggleHistory,
  onClose,
}: {
  view: "chat" | "history";
  // The active chat's title (the panel owns resolving it). Titles are written by
  // the agent, so they can be long — truncate and keep the full text in a
  // tooltip.
  title: string;
  onNewChat: () => void;
  onToggleHistory: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-grid-bright px-3 py-2">
      <span className="truncate text-sm font-medium text-text-bright" title={title}>
        {title}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="New chat" icon={PencilSquareIcon} onClick={onNewChat} />
        <IconButton
          label="History"
          icon={ClockIcon}
          onClick={onToggleHistory}
          active={view === "history"}
        />
        <IconButton label="Close" icon={XMarkIcon} onClick={onClose} />
      </div>
    </div>
  );
}

function IconButton({
  label,
  icon: Icon,
  onClick,
  active,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "rounded p-1.5 text-text-dimmed transition hover:bg-background-raised hover:text-text-bright",
        active && "bg-background-raised text-text-bright"
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

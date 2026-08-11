import { ClockIcon, PencilSquareIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";

export function DashboardAgentHeader({
  view,
  onNewChat,
  onToggleHistory,
  onClose,
}: {
  view: "chat" | "history";
  onNewChat: () => void;
  onToggleHistory: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-grid-bright px-3 py-2">
      <span className="text-sm font-medium text-text-bright">Chat</span>
      <div className="flex items-center gap-0.5">
        <IconButton label="New chat" icon={PencilSquareIcon} onClick={onNewChat} />
        <IconButton
          label="History"
          icon={ClockIcon}
          onClick={onToggleHistory}
          active={view === "history"}
        />
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={XMarkIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
          aria-label="Close"
        />
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

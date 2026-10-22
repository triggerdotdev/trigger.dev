import type { ReactNode } from "react";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";

export const PANEL_TITLE_CLASS = "truncate text-sm font-medium text-text-bright";

export function DashboardPanelHeader({
  title,
  actions,
  onClose,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-bright px-2">
      {title}
      <div className="flex shrink-0 items-center gap-1" data-agent-no-drag>
        {actions}
        <Button
          variant="minimal/small"
          className="aspect-square h-6 p-1"
          aria-label="Close (Esc)"
          tooltipDelay={500}
          tooltip={
            <span className="flex items-center">
              Close
              <ShortcutKey shortcut={{ key: "esc" }} variant="medium" />
            </span>
          }
          onClick={onClose}
          LeadingIcon={<CrossIcon className="size-4 text-text-dimmed" />}
        />
      </div>
    </div>
  );
}

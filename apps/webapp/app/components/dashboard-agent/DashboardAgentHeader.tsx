import { useState } from "react";
import { ChatFloatingPanel } from "~/assets/icons/ChatFloatingPanel";
import { ChatFullScreen } from "~/assets/icons/ChatFullScreen";
import { ChatRightPanel } from "~/assets/icons/ChatRightPanel";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { Button } from "~/components/primitives/Buttons";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import {
  DashboardAgentDeleteChatDialog,
  DashboardAgentHistoryMenu,
  type DashboardAgentChat,
} from "./DashboardAgentHistory";
import { chatHistoryTriggerLabel } from "./header-labels";
import type { DashboardAgentMode } from "./panel-layout";

const MODE_OPTIONS: { mode: DashboardAgentMode; label: string; Icon: typeof ChatFloatingPanel }[] =
  [
    { mode: "floating", label: "Floating window", Icon: ChatFloatingPanel },
    { mode: "rightPanel", label: "Side panel", Icon: ChatRightPanel },
    { mode: "fullscreen", label: "Fullscreen", Icon: ChatFullScreen },
  ];

// Display only. The key is registered once, in `DashboardAgent`; registering it
// anywhere else makes the keystroke fire twice.
export const NEW_CHAT_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "j",
  enabledOnInputElements: true,
};

export function DashboardAgentHeader({
  title,
  chats,
  currentChatId,
  thinkingChatId,
  onOpenHistory,
  onSelectChat,
  onDeleteChat,
  mode,
  onModeChange,
  onClose,
}: {
  title: string;
  chats: DashboardAgentChat[];
  currentChatId: string;
  thinkingChatId?: string | null;
  onOpenHistory: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  mode: DashboardAgentMode;
  onModeChange: (mode: DashboardAgentMode) => void;
  onClose: () => void;
}) {
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [historyOpenedAt, setHistoryOpenedAt] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);
  const [isModeMenuOpen, setModeMenuOpen] = useState(false);
  const CurrentModeIcon =
    MODE_OPTIONS.find((option) => option.mode === mode)?.Icon ?? ChatFloatingPanel;

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-bright pl-1 pr-1.5">
      <Popover
        open={isHistoryOpen}
        onOpenChange={(open) => {
          setHistoryOpen(open);
          if (open) {
            setHistoryOpenedAt(Date.now());
            onOpenHistory();
          }
        }}
      >
        <PopoverArrowTrigger
          variant="minimal"
          isOpen={isHistoryOpen}
          overflowHidden
          className="min-w-0"
          aria-label={chatHistoryTriggerLabel(title)}
          title={title}
        >
          <span className="truncate text-sm font-medium text-text-bright">{title}</span>
        </PopoverArrowTrigger>
        <PopoverContent
          className="w-72 max-w-(--radix-popover-content-available-width) p-0"
          align="start"
        >
          {historyOpenedAt === null ? null : (
            <DashboardAgentHistoryMenu
              chats={chats}
              currentChatId={currentChatId}
              thinkingChatId={thinkingChatId}
              now={historyOpenedAt}
              onSelect={(chatId) => {
                setHistoryOpen(false);
                onSelectChat(chatId);
              }}
              onRequestDelete={(chat) => {
                setHistoryOpen(false);
                setPendingDelete(chat);
              }}
            />
          )}
        </PopoverContent>
      </Popover>

      <DashboardAgentDeleteChatDialog
        chat={pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={onDeleteChat}
      />

      <div className="flex shrink-0 items-center gap-0.5" data-agent-no-drag>
        <Popover open={isModeMenuOpen} onOpenChange={setModeMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="minimal/small"
              className="aspect-square h-6 p-1"
              aria-label="Change chat display mode"
              tooltip="Display mode"
              LeadingIcon={<CurrentModeIcon className="size-4 text-text-dimmed" />}
            />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            {MODE_OPTIONS.map(({ mode: option, label, Icon }) => (
              <PopoverMenuItem
                key={option}
                icon={Icon}
                title={label}
                isSelected={option === mode}
                onClick={() => {
                  onModeChange(option);
                  setModeMenuOpen(false);
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
        <Button
          variant="minimal/small"
          className="aspect-square h-6 p-1"
          aria-label="Close (Esc)"
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

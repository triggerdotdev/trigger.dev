import { ArrowsPointingInIcon, ArrowsPointingOutIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverArrowTrigger, PopoverContent } from "~/components/primitives/Popover";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import {
  DashboardAgentDeleteChatDialog,
  DashboardAgentHistoryMenu,
  type DashboardAgentChat,
} from "./DashboardAgentHistory";
import { chatHistoryTriggerLabel } from "./header-labels";

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
  onNewChat,
  showNewChat,
  onOpenHistory,
  onSelectChat,
  onDeleteChat,
  onToggleFullscreen,
  isFullscreen,
  onClose,
}: {
  title: string;
  chats: DashboardAgentChat[];
  currentChatId: string;
  thinkingChatId?: string | null;
  onNewChat: () => void;
  showNewChat: boolean;
  onOpenHistory: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
  onClose: () => void;
}) {
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [historyOpenedAt, setHistoryOpenedAt] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);

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
        {showNewChat && (
          <Button
            variant="minimal/small"
            className="aspect-square h-6 p-1"
            aria-label="New chat"
            tooltip={
              <span className="flex items-center">
                New chat
                <ShortcutKey shortcut={NEW_CHAT_SHORTCUT} variant="medium" />
              </span>
            }
            onClick={onNewChat}
            LeadingIcon={<PlusIcon className="size-4 text-text-dimmed" />}
          />
        )}
        <Button
          variant="minimal/small"
          className="aspect-square h-6 p-1"
          aria-label={isFullscreen ? "Collapse into the side panel" : "Expand"}
          tooltip={isFullscreen ? "Collapse into the side panel" : "Expand"}
          onClick={onToggleFullscreen}
          LeadingIcon={
            isFullscreen ? (
              <ArrowsPointingInIcon className="size-4 text-text-dimmed" />
            ) : (
              <ArrowsPointingOutIcon className="size-4 text-text-dimmed" />
            )
          }
        />
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

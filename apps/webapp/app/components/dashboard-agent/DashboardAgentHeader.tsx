import { useState } from "react";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverArrowTrigger, PopoverContent } from "~/components/primitives/Popover";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import type { Shortcut } from "~/hooks/useShortcutKeys";
import { DashboardAgentHistoryMenu, type DashboardAgentChat } from "./DashboardAgentHistory";

/** New chat. Sits next to the panel's own ⌘J so the pair is easy to remember. */
export const NEW_CHAT_SHORTCUT: Shortcut = {
  modifiers: ["mod", "shift"],
  key: "j",
  // The composer holds focus while the panel is open, so a shortcut that only
  // fires outside inputs would never fire at all.
  enabledOnInputElements: true,
};

/**
 * The panel's title bar. Exactly as tall as the dashboard's own title bar
 * (`NavBar`), so the two dividers are one continuous line across the split.
 *
 * The chat's name is the history dropdown: the thing you're looking at is also
 * how you get to the others, which is one control instead of a name plus a
 * History button.
 */
export function DashboardAgentHeader({
  title,
  chats,
  currentChatId,
  thinkingChatId,
  onNewChat,
  onOpenHistory,
  onSelectChat,
  onDeleteChat,
  onClose,
}: {
  // The active chat's title (the panel owns resolving it). Titles are written by
  // the agent, so they can be long — truncate and keep the full text in a
  // tooltip.
  title: string;
  chats: DashboardAgentChat[];
  currentChatId: string;
  thinkingChatId?: string | null;
  onNewChat: () => void;
  /** Opening the dropdown is the moment to refresh the list. */
  onOpenHistory: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  onClose: () => void;
}) {
  const [isHistoryOpen, setHistoryOpen] = useState(false);

  return (
    // border-box, so h-10 + the 1px border is the same 40px as NavBar's
    // grid-rows-[auto_1px].
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-bright pl-1 pr-1.5">
      <Popover
        open={isHistoryOpen}
        onOpenChange={(open) => {
          setHistoryOpen(open);
          if (open) onOpenHistory();
        }}
      >
        <PopoverArrowTrigger
          variant="minimal"
          isOpen={isHistoryOpen}
          overflowHidden
          className="min-w-0"
          aria-label="Chat history"
          title={title}
        >
          <span className="truncate text-sm font-medium text-text-bright">{title}</span>
        </PopoverArrowTrigger>
        <PopoverContent
          className="w-72 max-w-(--radix-popover-content-available-width) p-0"
          align="start"
        >
          <DashboardAgentHistoryMenu
            chats={chats}
            currentChatId={currentChatId}
            thinkingChatId={thinkingChatId}
            onSelect={(chatId) => {
              setHistoryOpen(false);
              onSelectChat(chatId);
            }}
            onDelete={onDeleteChat}
          />
        </PopoverContent>
      </Popover>

      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="minimal/small"
          className="aspect-square h-6 p-1"
          aria-label="New chat"
          tooltip="New chat"
          shortcut={NEW_CHAT_SHORTCUT}
          onClick={onNewChat}
          LeadingIcon={<PlusIcon className="size-4 text-text-dimmed" />}
        />
        {/* Esc is handled by the panel (only while focus is inside it), so the
            key is shown here rather than registered as a global shortcut. */}
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

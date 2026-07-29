import { TrashIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { AgentList, AgentListRow, AgentListRowAction } from "./list-row";
import type { WatchChip } from "./WatchChips";

// Date fields arrive as strings over the loader's JSON.
export type DashboardAgentChat = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  /** The chat's active watches, for the panel's chip row. */
  watches?: WatchChip[];
  /** A watch resolved in this chat and the user hasn't opened it since. */
  hasUnreadWake?: boolean;
};

/**
 * Chats with an unread wake go to the top — a watch that fired is the reason to
 * open the panel at all. Everything else keeps the server's order (pinned first,
 * then most recent), so this is a stable sort on one key.
 */
function unreadFirst(chats: DashboardAgentChat[]): DashboardAgentChat[] {
  return [...chats].sort(
    (a, b) => Number(b.hasUnreadWake ?? false) - Number(a.hasUnreadWake ?? false)
  );
}

export function DashboardAgentHistory({
  chats,
  currentChatId,
  onSelect,
  onDelete,
}: {
  chats: DashboardAgentChat[];
  currentChatId: string;
  onSelect: (chatId: string) => void;
  onDelete: (chatId: string) => void;
}) {
  // Deleting a chat is irreversible, so it goes through a confirm step. Holding
  // the whole chat lets the dialog name what's being deleted.
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div className="p-2">
        {/* New chat lives as the header icon button only — no duplicate row here. */}
        {chats.length === 0 ? (
          <Paragraph variant="small" className="p-2 text-text-dimmed">
            No previous chats yet.
          </Paragraph>
        ) : (
          <AgentList>
            {unreadFirst(chats).map((chat) => (
              <AgentListRow
                key={chat.id}
                label={chat.title}
                unread={chat.hasUnreadWake ?? false}
                meta={
                  chat.lastMessageAt ? (
                    <DateTime date={chat.lastMessageAt} showTooltip={false} />
                  ) : undefined
                }
                variant={chat.id === currentChatId ? "selected" : "default"}
                onSelect={() => onSelect(chat.id)}
                action={
                  <AgentListRowAction
                    icon={TrashIcon}
                    label={`Delete chat: ${chat.title}`}
                    onClick={() => setPendingDelete(chat)}
                    danger
                  />
                }
              />
            ))}
          </AgentList>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>Delete this chat?</DialogHeader>
          <div className="flex flex-col gap-3 pt-3">
            <Paragraph>
              "{pendingDelete?.title}" and everything in it will be deleted. This can't be undone.
            </Paragraph>
            <FormButtons
              confirmButton={
                <Button
                  type="button"
                  variant="danger/medium"
                  LeadingIcon={TrashIcon}
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                  onClick={() => {
                    if (pendingDelete) onDelete(pendingDelete.id);
                    setPendingDelete(null);
                  }}
                >
                  Delete chat
                </Button>
              }
              cancelButton={
                <Button variant="tertiary/medium" onClick={() => setPendingDelete(null)}>
                  Cancel
                </Button>
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

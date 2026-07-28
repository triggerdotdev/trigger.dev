import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { AgentList, AgentListRow, AgentListRowAction } from "./list-row";

// Date fields arrive as strings over the loader's JSON.
export type DashboardAgentChat = {
  id: string;
  title: string;
  lastMessageAt: string | null;
};

export function DashboardAgentHistory({
  chats,
  currentChatId,
  onSelect,
  onNewChat,
  onDelete,
}: {
  chats: DashboardAgentChat[];
  currentChatId: string;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  onDelete: (chatId: string) => void;
}) {
  // Deleting a chat is irreversible, so it goes through a confirm step. Holding
  // the whole chat lets the dialog name what's being deleted.
  const [pendingDelete, setPendingDelete] = useState<DashboardAgentChat | null>(null);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div className="p-2">
        <button
          type="button"
          onClick={onNewChat}
          className="mb-1.5 flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left text-sm text-text-bright transition hover:bg-background-bright"
        >
          <PlusIcon className="size-4 text-green-500" />
          New chat
        </button>

        {chats.length === 0 ? (
          <Paragraph variant="small" className="p-2 text-text-dimmed">
            No previous chats yet.
          </Paragraph>
        ) : (
          <AgentList>
            {chats.map((chat) => (
              <AgentListRow
                key={chat.id}
                label={chat.title}
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

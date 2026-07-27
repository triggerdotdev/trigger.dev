import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

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
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-text-bright transition hover:bg-background-bright"
        >
          <PlusIcon className="size-4 text-green-500" />
          New chat
        </button>

        {chats.length === 0 ? (
          <Paragraph variant="small" className="p-2 text-text-dimmed">
            No previous chats yet.
          </Paragraph>
        ) : (
          <ol className="space-y-0.5">
            {chats.map((chat) => (
              <li key={chat.id}>
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-background-bright",
                    chat.id === currentChatId && "bg-background-hover hover:bg-background-hover"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(chat.id)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-hidden focus-custom"
                  >
                    <span className="line-clamp-1 text-sm text-text-bright">{chat.title}</span>
                    {chat.lastMessageAt && (
                      <span className="text-xs text-text-dimmed">
                        <DateTime date={chat.lastMessageAt} showTooltip={false} />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(chat)}
                    aria-label={`Delete chat: ${chat.title}`}
                    className="shrink-0 rounded p-1 text-text-dimmed opacity-0 transition-opacity hover:text-error group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-custom"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
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

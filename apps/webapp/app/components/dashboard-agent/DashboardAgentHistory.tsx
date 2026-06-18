import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

// Date fields arrive as strings over the loader's JSON.
export type DashboardAgentChat = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  updatedAt: string;
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
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <div className="p-2">
        <button
          type="button"
          onClick={onNewChat}
          className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-text-bright transition hover:bg-charcoal-800"
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
                    "group flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-charcoal-800",
                    chat.id === currentChatId && "bg-charcoal-750 hover:bg-charcoal-750"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(chat.id)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-custom"
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
                    onClick={() => onDelete(chat.id)}
                    aria-label="Delete chat"
                    className="shrink-0 rounded p-1 text-text-dimmed opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
